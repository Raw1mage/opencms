/**
 * ClaudeCodeLanguageModel — LanguageModelV2 implementation.
 *
 * Phase 4: Assembles convert, headers, sse, auth, protocol modules.
 * Single serialize, whitelist headers, zero SDK pollution.
 */
import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2StreamPart,
  LanguageModelV2Content,
  LanguageModelV2FinishReason,
  LanguageModelV2Usage,
  LanguageModelV2CallWarning,
} from "@ai-sdk/provider"
import { BASE_API_URL, IDENTITY_INTERACTIVE, toApiModelId } from "./protocol.js"
import { getMaxOutput } from "./models.js"
import {
  convertPrompt,
  convertTools,
  convertSystemBlocks,
  applyConversationCacheBreakpoint,
} from "./convert.js"
import { buildHeaders } from "./headers.js"
import { parseAnthropicSSE, mapFinishReason } from "./sse.js"
import type { ClaudeCredentials, TokenSet } from "./auth.js"
import { refreshTokenWithMutex } from "./auth.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ClaudeCodeProviderOptions {
  /** Current credentials (mutated on token refresh) */
  credentials: ClaudeCredentials
  /** Callback to persist refreshed credentials */
  onTokenRefresh?: (credentials: ClaudeCredentials) => void | Promise<void>
  /** Override API base URL */
  baseURL?: string
  /** Identity string for system prompt */
  identity?: string
  /** Whether prompt caching is enabled */
  enableCaching?: boolean
  /** Fast mode */
  fastMode?: boolean
}

// ---------------------------------------------------------------------------
// § 4.1  createClaudeCode — provider factory
// ---------------------------------------------------------------------------

export function createClaudeCode(options: ClaudeCodeProviderOptions) {
  return {
    languageModel(modelId: string): LanguageModelV2 {
      return new ClaudeCodeLanguageModel(modelId, options)
    },
  }
}

// ---------------------------------------------------------------------------
// § 4.2–4.5  ClaudeCodeLanguageModel
// ---------------------------------------------------------------------------

class ClaudeCodeLanguageModel implements LanguageModelV2 {
  readonly specificationVersion = "v2" as const
  readonly provider = "claude-code"
  readonly modelId: string
  readonly supportedUrls: Record<string, RegExp[]> = {}

  private readonly options: ClaudeCodeProviderOptions

  constructor(modelId: string, options: ClaudeCodeProviderOptions) {
    this.modelId = modelId
    this.options = options
  }

  // § 4.2  doStream — streaming generation
  async doStream(callOptions: LanguageModelV2CallOptions): Promise<{
    stream: ReadableStream<LanguageModelV2StreamPart>
    request?: { body?: unknown }
    response?: { headers?: Record<string, string> }
  }> {
    // § 4.2.1  Get auth token (refresh if needed)
    const creds = this.options.credentials
    await this.ensureValidToken(creds)

    const enableCaching = this.options.enableCaching ?? true

    // providerOptions arrives KEYED under the opencode providerId ("claude-cli"):
    // ProviderTransform.providerOptions wraps every option set as
    // { [providerId]: {...} } and the AI SDK forwards that record verbatim to
    // doStream. Read the keyed entry first, falling back to a flat object for
    // direct/test callers. Mirrors provider-codex's resolver — without this the
    // top-level reads below (effort/taskBudget/thinking/...) were always
    // undefined, which is why thinking-effort variants never reached the wire.
    const po: Record<string, any> =
      (callOptions.providerOptions?.["claude-cli"] as Record<string, any> | undefined) ??
      (callOptions.providerOptions as Record<string, any> | undefined) ??
      {}

    // Extended-thinking config (Anthropic `thinking` block), if a reasoning
    // variant is selected. Resolved once here so both max_tokens sizing and the
    // body assembly below agree on it.
    const thinking = po.thinking as { type?: string; budget_tokens?: number } | undefined

    // § 4.2.2  Convert prompt → messages + system
    const { messages, system, droppedTrailingAssistants } = convertPrompt(callOptions.prompt)

    // Loud signal (not a silent fallback): the conversation was not
    // user-terminated, so convertPrompt had to strip trailing assistant
    // message(s) to avoid Anthropic's "assistant message prefill" 400. This is
    // an upstream serialization defect — keep it visible.
    // issues/bug_20260529_claude_assistant_prefill_400.md
    if (droppedTrailingAssistants > 0) {
      console.warn(
        `[claude-provider] non-user-terminated conversation: stripped ${droppedTrailingAssistants} trailing assistant message(s) before dispatch (model=${this.modelId}). Upstream serialization should append a user/tool turn. See issues/bug_20260529_claude_assistant_prefill_400.md`,
      )
    }

    // datasheet §9.2: sliding conversation cache breakpoint on the last block.
    // Without it the whole history was reprocessed as fresh input every turn.
    applyConversationCacheBreakpoint(messages, enableCaching)

    // Find first user message text for billing header
    const firstUserMsg = messages.find((m) => m.role === "user")
    const billingContent = firstUserMsg
      ? typeof firstUserMsg.content === "string"
        ? firstUserMsg.content
        : JSON.stringify(firstUserMsg.content)
      : undefined

    // § 4.2.3  Convert tools (with mcp__ prefix + tools-block cache_control)
    const tools = convertTools(
      callOptions.tools?.filter((t): t is Extract<typeof t, { type: "function" }> => t.type === "function"),
      enableCaching,
    )

    // § 4.2.4  Convert system blocks (with cache_control)
    const systemBlocks = convertSystemBlocks({
      systemText: system,
      enableCaching,
      identity: this.options.identity ?? IDENTITY_INTERACTIVE,
      billingContent,
    })

    // § 4.2.5  Build headers from scratch
    //
    // Auth posture (DD-16): opencode is OAuth-only. The `isOAuth` flag below
    // is hardcoded to true because the runtime never holds API-key credentials
    // — the multi-account subscription router would not work with bare keys.
    // The credential type guard exists only to FAIL LOUD if a non-OAuth
    // credential ever sneaks in, not to enable a fallback.
    if (creds.type !== "oauth" && creds.type !== "subscription") {
      throw new Error(
        `claude-provider: opencode is OAuth-only (DD-16); refusing creds.type="${String(creds.type)}"`,
      )
    }
    const envBetasRaw = process.env.ANTHROPIC_BETAS
    const headers = buildHeaders({
      accessToken: creds.access!,
      modelId: this.modelId,
      isOAuth: true,
      orgID: creds.orgID,
      billingContent,
      fastMode: this.options.fastMode,
      effort: !!po.effort,
      taskBudget: !!po.taskBudget,
      envBetas: envBetasRaw ? envBetasRaw.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
      // Deployment posture (DD-4 + DD-17): opencode runs as a daemon serving
      // SSE to web/TUI clients, not a TTY. provider is always firstParty.
      provider: "firstParty",
      isInteractive: false,
      showThinkingSummaries: !!po.showThinkingSummaries,
      disableExperimentalBetas: !!process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS,
      disableInterleavedThinking: !!process.env.DISABLE_INTERLEAVED_THINKING,
    })

    // § 4.2.6  Build request body — single serialize
    let maxTokens = callOptions.maxOutputTokens ?? getMaxOutput(this.modelId)

    // Anthropic counts thinking tokens INSIDE max_tokens and rejects requests
    // where budget_tokens >= max_tokens. opencode's maxOutputTokens() hands us a
    // *text* budget (default-capped at 32k), so when extended thinking is on we
    // must grow max_tokens to text+budget, clamped to the model's true output
    // ceiling. @ai-sdk/anthropic does this addition internally; the native
    // provider serializes straight to the wire, so it has to do it here.
    if (thinking?.type === "enabled" && typeof thinking.budget_tokens === "number") {
      maxTokens = Math.min(getMaxOutput(this.modelId), maxTokens + thinking.budget_tokens)
    }

    const body: Record<string, unknown> = {
      model: toApiModelId(this.modelId), // §6.3: strip [1m]/[2m] marker
      max_tokens: maxTokens,
      stream: true,
      system: systemBlocks,
      messages,
    }

    if (tools && tools.length > 0) {
      body.tools = tools
    }

    // Tool choice
    if (callOptions.toolChoice) {
      switch (callOptions.toolChoice.type) {
        case "auto":
          body.tool_choice = { type: "auto" }
          break
        case "required":
          body.tool_choice = { type: "any" }
          break
        case "tool":
          body.tool_choice = {
            type: "tool",
            name: `mcp__${callOptions.toolChoice.toolName}`,
          }
          break
        case "none":
          // Anthropic doesn't have explicit "none" — omit tool_choice
          break
      }
    }

    // Anthropic extended thinking is incompatible with temperature / top_p /
    // top_k overrides — the Messages API 400s (or silently ignores them) when
    // `thinking` is enabled, which requires temperature=1. Only forward sampling
    // params when thinking is OFF; otherwise let the server default hold.
    if (!thinking) {
      if (callOptions.temperature !== undefined) {
        body.temperature = callOptions.temperature
      }
      if (callOptions.topP !== undefined) {
        body.top_p = callOptions.topP
      }
      if (callOptions.topK !== undefined) {
        body.top_k = callOptions.topK
      }
    }

    if (thinking) {
      body.thinking = thinking
    }

    const bodyStr = JSON.stringify(body)

    // § 4.2.7  fetch — direct globalThis.fetch, zero middleware
    const baseURL = this.options.baseURL ?? BASE_API_URL
    // § 4.4  URL: /v1/messages?beta=true
    const url = `${baseURL}/v1/messages?beta=true`

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: bodyStr,
      signal: callOptions.abortSignal,
    })

    // § 4.5  Error handling
    if (!response.ok) {
      const errorBody = await response.text().catch(() => "")
      throw new Error(
        `Anthropic API error ${response.status}: ${errorBody.slice(0, 500)}`,
      )
    }

    if (!response.body) {
      throw new Error("Anthropic API returned no response body")
    }

    // § 4.2.8  Parse SSE → LMv2 StreamPart stream
    const stream = parseAnthropicSSE(response.body)

    // § 4.2.9  Return
    const responseHeaders: Record<string, string> = {}
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value
    })

    return {
      stream,
      request: { body },
      response: { headers: responseHeaders },
    }
  }

  // § 4.3  doGenerate — non-streaming (collects full stream)
  async doGenerate(callOptions: LanguageModelV2CallOptions): Promise<{
    content: LanguageModelV2Content[]
    finishReason: LanguageModelV2FinishReason
    usage: LanguageModelV2Usage
    warnings: LanguageModelV2CallWarning[]
    request?: { body?: unknown }
    response?: { headers?: Record<string, string> }
  }> {
    const { stream, request, response } = await this.doStream(callOptions)

    const content: LanguageModelV2Content[] = []
    let finishReason: LanguageModelV2FinishReason = "other"
    let usage: LanguageModelV2Usage = {
      inputTokens: undefined,
      outputTokens: undefined,
      totalTokens: undefined,
    }
    const warnings: LanguageModelV2CallWarning[] = []

    // Collect text and tool calls from stream
    const textParts = new Map<string, string>()
    const reasoningParts = new Map<string, string>()
    const toolInputParts = new Map<string, { toolName: string; input: string }>()

    const reader = stream.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      switch (value.type) {
        case "stream-start":
          if (value.warnings) warnings.push(...value.warnings)
          break
        case "text-start":
          textParts.set(value.id, "")
          break
        case "text-delta":
          textParts.set(value.id, (textParts.get(value.id) ?? "") + value.delta)
          break
        case "text-end": {
          const text = textParts.get(value.id)
          if (text) {
            content.push({ type: "text", text } as LanguageModelV2Content)
          }
          break
        }
        case "reasoning-start":
          reasoningParts.set(value.id, "")
          break
        case "reasoning-delta":
          reasoningParts.set(value.id, (reasoningParts.get(value.id) ?? "") + value.delta)
          break
        case "reasoning-end": {
          const text = reasoningParts.get(value.id)
          if (text) {
            content.push({ type: "reasoning", text } as LanguageModelV2Content)
          }
          break
        }
        case "tool-input-start":
          toolInputParts.set(value.id, { toolName: value.toolName, input: "" })
          break
        case "tool-input-delta": {
          const tool = toolInputParts.get(value.id)
          if (tool) tool.input += value.delta
          break
        }
        case "tool-input-end": {
          const tool = toolInputParts.get(value.id)
          if (tool) {
            content.push({
              type: "tool-call",
              toolCallId: value.id,
              toolName: tool.toolName,
              input: tool.input,
            } as LanguageModelV2Content)
          }
          break
        }
        case "finish":
          finishReason = value.finishReason
          usage = value.usage
          break
        case "error":
          throw value.error
      }
    }

    return { content, finishReason, usage, warnings, request, response }
  }

  // ---------------------------------------------------------------------------
  // Token refresh
  // ---------------------------------------------------------------------------

  private async ensureValidToken(creds: ClaudeCredentials): Promise<void> {
    if (creds.access && creds.expires && creds.expires > Date.now()) {
      return // Token still valid
    }

    // Refresh with mutex
    const tokens = await refreshTokenWithMutex(creds.refresh)
    creds.access = tokens.access
    creds.expires = tokens.expires
    if (tokens.refresh) {
      creds.refresh = tokens.refresh
    }

    // Notify host to persist
    if (this.options.onTokenRefresh) {
      await this.options.onTokenRefresh(creds)
    }
  }
}
