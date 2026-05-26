/**
 * harness/freerun-mode — OpenAI-compatible LlmClient implementation.
 *
 * Concrete implementation of `Iterate.LlmClient` and
 * `Consolidate.SummarizeClient` that talks to any provider exposing the
 * OpenAI `/v1/chat/completions` shape (rawbase / custom-provider-work
 * being the validated target for v1).
 *
 * Two modes per the freerun design choice (Option D):
 *   - Planning   → server-enforced `response_format: json_schema`, no tools
 *   - Execution  → Claude-style: tools enabled, no response_format;
 *                  agent-loop runs to a final content message; iterate.ts
 *                  Zod-parses the content into ExecutionOutcome.
 *
 * Tool dispatch: this client is responsible for the agent loop. On each
 * round trip, if the model returns tool_calls, dispatch via the injected
 * `ToolDispatcher`, append the results to the conversation, and call
 * again. Stop when finish_reason !== "tool_calls" (model emitted final
 * content) or `max_tool_rounds` is hit.
 */

import { FreerunBus } from "../observability/bus"
import type { Iterate } from "../runtime/iterate"
import type { Consolidate } from "../runtime/consolidate"
import type { PlanningOutcome } from "../types"

export namespace FreerunLlmClient {
  // ============================================================================
  // Tool dispatcher seam (injected by workflow-runner adapter)
  // ============================================================================

  export interface ToolDispatcher {
    /**
     * Execute the tool by name with the supplied arguments. Return a string
     * (json or plain text) that will be sent back as the tool result message.
     */
    dispatch(toolName: string, args: unknown): Promise<string>
  }

  // ============================================================================
  // Construction
  // ============================================================================

  export interface ClientOptions {
    /** OpenAI-compatible chat-completions endpoint base URL (without trailing slash). */
    baseUrl: string
    /** Model id sent in the request body (e.g. "qwen3.6-35b-a3b-q4_k_m"). */
    modelId: string
    /** API key for the Authorization header (empty string if upstream doesn't require). */
    apiKey?: string
    /** Tool dispatcher — undefined disables tool dispatch entirely (planning-only client). */
    toolDispatcher?: ToolDispatcher
    /** Max round trips before forcing a final content emission. Defaults to 8. */
    maxToolRounds?: number
    /** Per-request HTTP timeout in ms. Defaults to 120_000. */
    httpTimeoutMs?: number
    /** Telemetry session id (for Bus emission). */
    sessionId?: string
    /** Telemetry iteration counter (for Bus emission). */
    iteration?: number
    /** Telemetry node id. */
    nodeId?: string
  }

  /** Build a client implementing both Iterate.LlmClient and Consolidate.SummarizeClient. */
  export function create(
    opts: ClientOptions,
  ): Iterate.LlmClient & Consolidate.SummarizeClient {
    const baseUrl = opts.baseUrl.replace(/\/$/, "")
    const timeout = opts.httpTimeoutMs ?? 120_000
    const maxRounds = opts.maxToolRounds ?? 8

    async function postChat(body: Record<string, unknown>): Promise<any> {
      const headers: Record<string, string> = {
        "content-type": "application/json",
      }
      if (opts.apiKey) headers["authorization"] = `Bearer ${opts.apiKey}`
      if (opts.sessionId) headers["x-opencode-session-id"] = opts.sessionId
      headers["x-opencode-mode"] = "freerun"
      if (opts.iteration !== undefined) headers["x-opencode-iteration"] = String(opts.iteration)
      if (opts.nodeId) headers["x-opencode-node-id"] = opts.nodeId

      const ac = new AbortController()
      const t = setTimeout(() => ac.abort(new Error(`HTTP timeout after ${timeout}ms`)), timeout)
      try {
        const t0 = Date.now()
        const resp = await fetch(`${baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: ac.signal,
        })
        const text = await resp.text()
        if (!resp.ok) {
          throw new Error(`upstream ${resp.status}: ${text.slice(0, 500)}`)
        }
        const parsed = JSON.parse(text)
        // Best-effort telemetry — does not block.
        if (opts.sessionId !== undefined && opts.iteration !== undefined) {
          await FreerunBus.emit.llmResponseReceived({
            sessionID: opts.sessionId,
            iteration: opts.iteration,
            latencyMs: Date.now() - t0,
            tokensIn: parsed.usage?.prompt_tokens,
            tokensOut: parsed.usage?.completion_tokens,
            schemaValidationResult: "skipped",
            finishReason: parsed.choices?.[0]?.finish_reason,
          })
        }
        return parsed
      } finally {
        clearTimeout(t)
      }
    }

    async function callPlanning(req: Iterate.PlanningRequest): Promise<PlanningOutcome> {
      const body = {
        model: opts.modelId,
        messages: [
          { role: "system", content: req.systemPrompt },
          { role: "user", content: req.userMessage },
        ],
        temperature: req.temperature,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: req.responseSchemaName,
            schema: req.responseSchema,
            strict: true,
          },
        },
        stream: false,
      }
      const resp = await postChat(body)
      const content: string = resp.choices?.[0]?.message?.content ?? ""
      if (content.length === 0) {
        throw new Error("planning response empty")
      }
      return JSON.parse(content) as PlanningOutcome
    }

    async function callExecution(req: Iterate.ExecutionRequest): Promise<Iterate.ExecutionRawResult> {
      // Build initial messages.
      const messages: Array<Record<string, unknown>> = [
        { role: "system", content: req.systemPrompt },
        { role: "user", content: req.userMessage },
      ]
      const oaiTools = req.tools.length > 0
        ? req.tools.map((t) => ({
            type: "function",
            function: {
              name: t.name,
              description: (t as any).description ?? "",
              parameters: (t as any).parameters ?? { type: "object", properties: {} },
            },
          }))
        : undefined

      let toolCallCount = 0
      for (let round = 0; round < maxRounds; round++) {
        const body: Record<string, unknown> = {
          model: opts.modelId,
          messages,
          temperature: req.temperature,
          stream: false,
        }
        if (oaiTools !== undefined && !req.toolsSuppressed) body.tools = oaiTools
        const resp = await postChat(body)
        const msg = resp.choices?.[0]?.message
        const finishReason: string | undefined = resp.choices?.[0]?.finish_reason
        if (!msg) throw new Error("execution response missing message")

        // Append assistant turn to history.
        messages.push({
          role: "assistant",
          content: msg.content ?? "",
          ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {}),
        })

        const toolCalls = msg.tool_calls as Array<{ id: string; function: { name: string; arguments: string } }> | undefined
        if (toolCalls && toolCalls.length > 0 && opts.toolDispatcher) {
          for (const tc of toolCalls) {
            toolCallCount++
            const tToolStart = Date.now()
            let resultText = ""
            let success = false
            try {
              const args = JSON.parse(tc.function.arguments || "{}")
              if (opts.sessionId && opts.iteration !== undefined && opts.nodeId) {
                await FreerunBus.emit.toolInvoked({
                  sessionID: opts.sessionId,
                  iteration: opts.iteration,
                  nodeID: opts.nodeId,
                  toolName: tc.function.name,
                  args,
                })
              }
              resultText = await opts.toolDispatcher.dispatch(tc.function.name, args)
              success = true
            } catch (err) {
              resultText = `Tool error: ${err instanceof Error ? err.message : String(err)}`
            }
            messages.push({
              role: "tool",
              tool_call_id: tc.id,
              content: resultText,
            })
            if (opts.sessionId && opts.iteration !== undefined && opts.nodeId) {
              await FreerunBus.emit.toolCompleted({
                sessionID: opts.sessionId,
                iteration: opts.iteration,
                nodeID: opts.nodeId,
                toolName: tc.function.name,
                latencyMs: Date.now() - tToolStart,
                success,
                resultExcerpt: resultText.slice(0, 200),
              })
            }
          }
          continue // next round
        }

        // No tool calls (or no dispatcher) → final content.
        return {
          finalContent: msg.content ?? "",
          toolCallCount,
        }
      }
      // Max rounds exhausted — force a final emission round with stricter framing.
      messages.push({
        role: "user",
        content:
          "You have exceeded the tool-call budget for this iteration. " +
          "Emit your ExecutionOutcome JSON now based on what you've already gathered.",
      })
      const final = await postChat({
        model: opts.modelId,
        messages,
        temperature: req.temperature,
        stream: false,
      })
      return {
        finalContent: final.choices?.[0]?.message?.content ?? "",
        toolCallCount,
      }
    }

    async function summarize(req: Consolidate.SummarizeRequest): Promise<string> {
      const systemPrompt =
        "You are a consolidation helper for an freerun-mode autonomous agent. " +
        "Given a subtree of completed work, produce a concise summary that preserves " +
        "what was decided, what was discovered, and any residual blockers. " +
        `Soft cap: ${req.maxTokens} tokens. Output plain markdown, no code fences.`
      const childRollup = req.children
        .map(
          (c) =>
            `### ${c.id} (${c.mode}) — ${c.title}\n` +
            (c.observations.length > 0 ? `obs: ${c.observations.join("; ")}\n` : "") +
            (c.decisions.length > 0
              ? `dec: ${c.decisions.map((d) => `${d.decision} (${d.rationale})`).join("; ")}\n`
              : "") +
            (c.blockers.length > 0 ? `blk: ${c.blockers.join("; ")}\n` : "") +
            (c.results !== null ? `res: ${JSON.stringify(c.results).slice(0, 300)}\n` : ""),
        )
        .join("\n")
      const userMessage =
        `# Parent node\n${req.parent.id}: ${req.parent.title}\n${req.parent.body}\n\n` +
        `# Children rollup\n${childRollup}\n\n` +
        "# Your task\nWrite the consolidated summary (markdown, <= " +
        `${req.maxTokens} tokens, no preamble):`
      const resp = await postChat({
        model: opts.modelId,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        temperature: 0.3,
        stream: false,
      })
      return resp.choices?.[0]?.message?.content ?? ""
    }

    return { callPlanning, callExecution, summarize }
  }
}
