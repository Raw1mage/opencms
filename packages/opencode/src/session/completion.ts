import z from "zod"
import type { ModelMessage, Tool as AITool } from "ai"
import { Identifier } from "@/id/id"
import { Provider } from "@/provider/provider"
import { Agent } from "@/agent/agent"
import { MessageV2 } from "./message-v2"
import { LLM } from "./llm"
import { SessionProcessor } from "./processor"
import { SessionPrompt } from "./prompt"
import { Account } from "@/account"
import { getRateLimitTracker, getHealthTracker, isRateLimitError } from "@/account/rotation"
import { Log } from "@/util/log"

/**
 * daemon_stateless_completion (DD-1 route D-c): a stateless one-shot
 * completion path. Calls LLM.stream directly with a synthetic ephemeral
 * sessionID that is a valid Identifier but is NEVER passed to Session.create
 * and never reaches any Session.update* write. Persists NOTHING.
 *
 * DD-4 verified: LLM.stream itself performs no storage writes — persistence
 * lives entirely in SessionProcessor.process (which wraps LLM.stream). Its
 * Session.get reads (FreerunResolver / isSubagentSession / CapabilityLayer)
 * all graceful-degrade on a missing session. bare layer-zeroing is built into
 * LLM.stream:847 (agent.name==="bare" keeps only userSystem).
 */
export namespace Completion {
  const log = Log.create({ service: "completion" })

  export class CompletionError extends Error {
    constructor(
      public code: "BAD_REQUEST" | "RATE_LIMITED" | "PROVIDER_ERROR" | "MODEL_NOT_FOUND" | "DAEMON_ERROR",
      message: string,
    ) {
      super(message)
      this.name = "CompletionError"
    }
  }

  export const Input = z
    .object({
      agent: z.string().optional(),
      system: z.string().optional(),
      parts: z
        .array(
          z.object({
            type: z.literal("text"),
            text: z.string(),
          }),
        )
        .min(1),
      model: z.object({
        providerId: z.string(),
        modelID: z.string(),
        accountId: z.string().optional(),
      }),
      format: MessageV2.Format.optional(),
    })
    .meta({ ref: "CompletionRequest" })
  export type Input = z.infer<typeof Input>

  export const ResponsePart = z.discriminatedUnion("type", [
    z.object({
      type: z.literal("tool"),
      tool: z.literal("StructuredOutput"),
      state: z.object({
        status: z.literal("completed"),
        output: z.any(),
      }),
    }),
    z.object({
      type: z.literal("text"),
      text: z.string(),
    }),
  ])
  export type ResponsePart = z.infer<typeof ResponsePart>

  export const Response = z
    .object({
      parts: z.array(ResponsePart),
    })
    .meta({ ref: "CompletionResponse" })
  export type Response = z.infer<typeof Response>

  // Bounded retry budget for rate-limit account rotation. Stateless one-shot
  // does not pin an account across turns; a small N is sufficient.
  const MAX_RATE_LIMIT_RETRIES = 2

  /**
   * Select a healthy, non-rate-limited account from the same provider's pool,
   * excluding any IDs already tried this call. Returns undefined when the pool
   * is exhausted (→ RATE_LIMITED to the caller).
   */
  async function selectHealthyAccount(
    providerId: string,
    modelID: string,
    exclude: Set<string>,
  ): Promise<string | undefined> {
    const accounts = await Account.list(providerId).catch(() => ({}))
    const rateLimitTracker = getRateLimitTracker()
    const healthTracker = getHealthTracker()
    let bestAccountId: string | undefined
    let bestScore = -1
    for (const [accId] of Object.entries(accounts)) {
      if (exclude.has(accId)) continue
      if (rateLimitTracker.isRateLimited(accId, providerId, modelID)) continue
      const score = healthTracker.getScore(accId, providerId)
      if (score < 50) continue
      if (score > bestScore) {
        bestScore = score
        bestAccountId = accId
      }
    }
    return bestAccountId
  }

  /**
   * Run one stateless completion. No Session.create / Session.updateMessage /
   * Session.updatePart anywhere on this path (success OR failure).
   */
  export async function run(input: Input): Promise<Response> {
    // Resolve model — MODEL_NOT_FOUND on miss.
    let model: Provider.Model
    try {
      model = await Provider.getModel(input.model.providerId, input.model.modelID)
    } catch (e) {
      throw new CompletionError("MODEL_NOT_FOUND", e instanceof Error ? e.message : String(e))
    }

    // Resolve agent (default bare → layer-zeroing inside LLM.stream:847).
    const agentName = input.agent ?? "bare"
    const agent = await Agent.get(agentName)
    if (!agent) {
      throw new CompletionError("BAD_REQUEST", `agent "${agentName}" not found`)
    }

    // Mint an ephemeral, never-persisted sessionID (valid Identifier).
    const sessionID = Identifier.ascending("session")

    // Build an in-memory user message (NOT persisted).
    const messageID = Identifier.ascending("message")
    const user: MessageV2.User = {
      id: messageID,
      sessionID,
      role: "user",
      time: { created: Date.now() },
      agent: agentName,
      model: {
        providerId: input.model.providerId,
        modelID: input.model.modelID,
        accountId: input.model.accountId,
      },
      system: input.system,
      format: input.format,
    }

    // Single user turn → ModelMessage[].
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: input.parts.map((p) => ({ type: "text" as const, text: p.text })),
      },
    ]

    // Structured output capture (json_schema mode).
    let structuredOutput: unknown | undefined
    const tools: Record<string, AITool> = {}
    const system: string[] = []
    if (input.format?.type === "json_schema") {
      tools["StructuredOutput"] = SessionPrompt.createStructuredOutputTool({
        schema: input.format.schema,
        onSuccess: (output) => {
          structuredOutput = output
        },
      })
      system.push(STRUCTURED_OUTPUT_DIRECTIVE)
    }

    const triedAccounts = new Set<string>()
    let accountId = input.model.accountId
    if (accountId) triedAccounts.add(accountId)

    let attempt = 0
    while (true) {
      const abort = new AbortController()
      const textParts: string[] = []
      structuredOutput = undefined
      try {
        const stream = await LLM.stream({
          user,
          sessionID,
          model,
          accountId,
          agent,
          system,
          abort: abort.signal,
          messages,
          tools,
          // json_schema parity with the message path: the StructuredOutput tool
          // must be FORCED, not merely advertised. LLM.stream passes toolChoice
          // through verbatim (llm.ts:2399) and does NOT derive it from `format`;
          // the message path's "required" is computed in the processor layer
          // (prompt.ts:3562-3564) which this D-c route bypasses. Without this the
          // model can answer in plain text → empty structuredOutput. Only the
          // StructuredOutput tool is in `tools` here, so "required" == force it.
          toolChoice: input.format?.type === "json_schema" ? "required" : undefined,
          format: input.format,
        } as LLM.StreamInput)

        for await (const value of stream.fullStream) {
          switch (value.type) {
            case "text-delta":
              textParts.push(value.text)
              break
            case "error":
              throw value.error
            default:
              break
          }
        }

        // Surface a stream-level finish error if the SDK swallowed it into
        // the result rather than throwing.
        const finishError = await stream.finishReason.then(() => undefined).catch((e) => e)
        if (finishError) throw finishError

        return buildResponse(structuredOutput, textParts.join(""))
      } catch (e) {
        const rateLimited = isRateLimitError(e)
        // isModelTemporaryError is NOT exported from processor.ts (and the天條
        // forbids modifying that file). Use the exported isTransientCapacityError
        // (529/503/overloaded — a strict subset of temporary errors) plus the
        // exported isRateLimitError for the cascade-eligible classification.
        const temporary = SessionProcessor.isTransientCapacityError(e)

        if (rateLimited && attempt < MAX_RATE_LIMIT_RETRIES) {
          const next = await selectHealthyAccount(input.model.providerId, input.model.modelID, triedAccounts)
          if (next) {
            log.info("rate-limit: rotating account", { from: accountId, to: next, attempt })
            accountId = next
            triedAccounts.add(next)
            attempt++
            continue
          }
        }

        if (rateLimited) {
          throw new CompletionError("RATE_LIMITED", e instanceof Error ? e.message : String(e))
        }
        if (temporary) {
          throw new CompletionError("PROVIDER_ERROR", e instanceof Error ? e.message : String(e))
        }
        throw new CompletionError("DAEMON_ERROR", e instanceof Error ? e.message : String(e))
      }
    }
  }

  function buildResponse(structuredOutput: unknown | undefined, text: string): Response {
    const parts: ResponsePart[] = []
    if (structuredOutput !== undefined) {
      parts.push({
        type: "tool",
        tool: "StructuredOutput",
        state: { status: "completed", output: structuredOutput },
      })
    }
    if (text.length > 0) {
      parts.push({ type: "text", text })
    }
    return { parts }
  }

  // Mirror of prompt.ts STRUCTURED_OUTPUT_SYSTEM_PROMPT — kept local so this
  // module does not depend on a non-exported prompt.ts constant.
  const STRUCTURED_OUTPUT_DIRECTIVE =
    "IMPORTANT: The user has requested structured output. You MUST use the StructuredOutput tool to provide your final response. Do NOT respond with plain text - you MUST call the StructuredOutput tool with your answer formatted according to the schema."
}
