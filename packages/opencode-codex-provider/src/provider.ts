/**
 * CodexLanguageModel — LanguageModelV2 implementation.
 *
 * Native Responses API client that bypasses @ai-sdk/openai entirely.
 * Supports both WebSocket (primary) and HTTP SSE (fallback) transports.
 *
 * Pattern: follows @opencode-ai/claude-provider/provider.ts exactly.
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
import { CODEX_API_URL, CODEX_WS_URL } from "./protocol.js"
import { getCompactThreshold, getMaxOutput } from "./models.js"
import { convertPrompt, convertTools } from "./convert.js"
import { buildHeaders, buildClientMetadata } from "./headers.js"
import { parseSSEStream, mapResponseStream, mapFinishReason } from "./sse.js"
import type { RequestOptionsShape } from "./empty-turn-classifier.js"
import { createHash } from "crypto"
import { refreshTokenWithMutex } from "./auth.js"
import { tryWsTransport, resetWsSession } from "./transport-ws.js"
import type { CodexCredentials, ResponsesApiRequest, WindowState } from "./types.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CodexProviderOptions {
  /** Current credentials (mutated on token refresh) */
  credentials: CodexCredentials
  /** Callback to persist refreshed credentials */
  onTokenRefresh?: (credentials: CodexCredentials) => void | Promise<void>
  /** Conversation ID for prompt_cache_key + window lineage */
  conversationId?: string
  /** Session ID for correlation headers */
  sessionId?: string
  /** Installation UUID for analytics */
  installationId?: string
  /** User-Agent string */
  userAgent?: string
  /** Override API URL */
  baseURL?: string
}

// ---------------------------------------------------------------------------
// § 1  createCodex — provider factory
// ---------------------------------------------------------------------------

export function createCodex(options: CodexProviderOptions) {
  return {
    languageModel(modelId: string): LanguageModelV2 {
      return new CodexLanguageModel(modelId, options)
    },
  }
}

export function buildResponsesApiRequest(input: {
  modelId: string
  instructions?: string
  input: ResponsesApiRequest["input"]
  tools?: ResponsesApiRequest["tools"]
  promptCacheKey: string
  installationId?: string
  window: WindowState
  providerOptions?: Record<string, unknown>
}): ResponsesApiRequest {
  const po = input.providerOptions ?? {}
  const body: ResponsesApiRequest = {
    model: input.modelId,
    instructions: input.instructions,
    input: input.input,
    // Mode 1 server-side compaction request shape: regular /responses calls
    // carry context_management so Codex can compact the hidden server window
    // inline instead of relying only on opencode's standalone kind-4 path.
    context_management: [{ type: "compaction", compact_threshold: getCompactThreshold(input.modelId) }],
    prompt_cache_key: (po.promptCacheKey as string) ?? input.promptCacheKey,
    client_metadata: buildClientMetadata({
      installationId: input.installationId,
      window: input.window,
    }),
  }

  body.store = (po.store as boolean) ?? false

  if (po.serviceTier) body.service_tier = po.serviceTier as string
  if (po.include) body.include = po.include as string[]

  if (po.reasoningEffort || po.reasoningSummary) {
    body.reasoning = {}
    if (po.reasoningEffort) body.reasoning.effort = po.reasoningEffort as string
    if (po.reasoningSummary) body.reasoning.summary = po.reasoningSummary as string
  }

  if (po.textVerbosity) body.text = { verbosity: po.textVerbosity as string }

  if (input.tools && input.tools.length > 0) {
    body.tools = input.tools
    body.tool_choice = "auto"
  }

  return body
}

// ---------------------------------------------------------------------------
// § 2  CodexLanguageModel
// ---------------------------------------------------------------------------

class CodexLanguageModel implements LanguageModelV2 {
  readonly specificationVersion = "v2" as const
  readonly provider = "codex"
  readonly modelId: string
  readonly supportedUrls: Record<string, RegExp[]> = {}

  private readonly options: CodexProviderOptions
  private turnState?: string
  private window: WindowState

  constructor(modelId: string, options: CodexProviderOptions) {
    this.modelId = modelId
    this.options = options
    this.window = {
      conversationId: options.conversationId ?? `codex-${Date.now()}`,
      generation: 0,
    }
  }

  // § 2.1  doStream — streaming generation
  async doStream(callOptions: LanguageModelV2CallOptions): Promise<{
    stream: ReadableStream<LanguageModelV2StreamPart>
    request?: { body?: unknown }
    response?: { headers?: Record<string, string> }
  }> {
    // § 2.1.1  Ensure valid token
    await this.ensureValidToken()

    // § 2.1.2  Resolve per-request session context from headers/providerOptions
    // Model instance is cached and reused across sessions — session context must
    // come from the request, not the constructor.
    const requestHeaders = callOptions.headers as Record<string, string> | undefined
    const sessionId = requestHeaders?.["x-opencode-session"]
      ?? requestHeaders?.["session_id"]
      ?? this.options.sessionId
    const accountId = requestHeaders?.["x-opencode-account-id"]
      ?? this.options.credentials.accountId

    // @plans/provider-hotfix Phase 2 — context-window lineage pulled from
    // opencode request headers (llm.ts sets them only for subagent sessions;
    // empty-string sentinel means "top level, do not emit").
    const parentThreadId = requestHeaders?.["x-opencode-parent-session"] || undefined
    const subagentLabel = requestHeaders?.["x-opencode-subagent"] || undefined

    // Stable prompt_cache_key per session (NOT per model instance)
    const cacheKey = sessionId
      ? `codex-${accountId || "default"}-${sessionId}`
      : this.window.conversationId

    // Update window conversationId to match session for lineage tracking
    if (sessionId && this.window.conversationId !== sessionId) {
      this.window.conversationId = sessionId
    }

    // § 2.1.3  Convert prompt → instructions + input
    const { instructions, input } = convertPrompt(callOptions.prompt)

    // § 2.1.4  Convert tools
    const tools = convertTools(
      callOptions.tools?.filter((t): t is Extract<typeof t, { type: "function" }> => t.type === "function"),
    )

    // § 2.1.5  Extract provider options (nested under "codex" or "openai" key)
    const po = (callOptions.providerOptions?.codex
      ?? callOptions.providerOptions?.openai
      ?? callOptions.providerOptions
      ?? {}) as Record<string, unknown>

    // § 2.1.6  Build request body — match old AI SDK adapter output exactly
    const body = buildResponsesApiRequest({
      modelId: this.modelId,
      instructions,
      input,
      tools,
      promptCacheKey: cacheKey,
      installationId: this.options.installationId,
      window: this.window,
      providerOptions: po,
    })

    // NOTE: max_output_tokens is NOT supported by Codex API (400 error).
    // Codex server controls output length internally via context_management.

    // § 2.1.5  Try WebSocket transport first
    const wsSessionId = sessionId ?? this.window.conversationId
    const wsTransport = await tryWsTransport({
      sessionId: wsSessionId,
      accessToken: this.options.credentials.access!,
      accountId: accountId,
      turnState: this.turnState,
      body: body as unknown as Record<string, unknown>,
      wsUrl: CODEX_WS_URL,
      userAgent: this.options.userAgent,
      conversationId: this.window.conversationId,
    })

    // Build classifier log context once (reused for WS + HTTP paths).
    // spec codex-empty-turn-recovery: log payload assembly per data-schema.json.
    const requestOptionsShape: RequestOptionsShape = {
      store: (body as any).store === true,
      hasReasoningEffort: !!(body as any).reasoning?.effort,
      reasoningEffortValue: ((body as any).reasoning?.effort as string | undefined) ?? null,
      includeFields: Array.isArray((body as any).include) ? ((body as any).include as string[]) : [],
      hasTools: Array.isArray((body as any).tools) && (body as any).tools.length > 0,
      toolCount: Array.isArray((body as any).tools) ? (body as any).tools.length : 0,
      promptCacheKeyHash: createHash("sha256")
        .update(String((body as any).prompt_cache_key ?? ""))
        .digest("hex")
        .slice(0, 16),
      inputItemCount: Array.isArray((body as any).input) ? (body as any).input.length : 0,
      instructionsByteSize: typeof (body as any).instructions === "string"
        ? Buffer.byteLength((body as any).instructions, "utf-8")
        : 0,
    }
    const logContext = {
      sessionId: wsSessionId,
      accountId: accountId ?? null,
      modelId: this.modelId,
      requestOptionsShape,
    }

    if (wsTransport) {
      // WS succeeded — map events to LMv2 stream
      const { events, getSnapshot } = wsTransport
      const { stream, responseIdPromise } = mapResponseStream(events, {
        logContext,
        getTransportSnapshot: getSnapshot,
      })
      // Capture response metadata asynchronously
      responseIdPromise.then((id) => {
        if (id) {
          // Store for providerMetadata access
          (this as any)._lastResponseId = id
        }
      })
      return { stream, request: { body } }
    }

    // § 2.1.7  HTTP SSE fallback — add stream:true for HTTP (WS strips it)
    body.stream = true
    const headers = buildHeaders({
      accessToken: this.options.credentials.access!,
      accountId: accountId,
      turnState: this.turnState,
      window: this.window,
      parentThreadId,
      subagentLabel,
      installationId: this.options.installationId,
      sessionId: wsSessionId,
      userAgent: this.options.userAgent,
      conversationId: this.window.conversationId,
    })

    const url = this.options.baseURL ?? CODEX_API_URL
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: callOptions.abortSignal,
    })

    // Capture turn state from response
    const newTurnState = response.headers.get("x-codex-turn-state")
    if (newTurnState) this.turnState = newTurnState

    // Error handling
    if (!response.ok) {
      const ct = response.headers.get("content-type") ?? ""
      if (ct.includes("application/json") || !ct.includes("text/event-stream")) {
        const errorBody = await response.text()
        // API-tier OAuth revocation: refresh endpoint may still mint access tokens,
        // but chatgpt.com/backend-api rejects them with code:"token_revoked" once
        // the upstream user session/grant is killed. Clear creds and surface the
        // same re-login signal as the refresh-tier path so the rotation layer and
        // user see one consistent error class.
        if (response.status === 401 && errorBody.includes('"token_revoked"')) {
          const creds = this.options.credentials
          creds.refresh = ""
          creds.access = ""
          creds.expires = 0
          if (this.options.onTokenRefresh) await this.options.onTokenRefresh(creds)
          throw new Error("codex auth: refresh_token revoked — re-login required")
        }
        throw new Error(`Codex API error (${response.status}): ${errorBody.slice(0, 200)}`)
      }
    }

    if (!response.body) {
      throw new Error("Codex API returned no response body")
    }

    // Parse SSE → events → LMv2 stream
    const sseEvents = parseSSEStream(response.body)
    const { stream, responseIdPromise } = mapResponseStream(sseEvents, { logContext })
    responseIdPromise.then((id) => {
      if (id) (this as any)._lastResponseId = id
    })

    const responseHeaders: Record<string, string> = {}
    response.headers.forEach((value, key) => { responseHeaders[key] = value })

    return { stream, request: { body }, response: { headers: responseHeaders } }
  }

  // § 2.2  doGenerate — non-streaming (collects full stream)
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
          if (text) content.push({ type: "text", text } as LanguageModelV2Content)
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
          if (text) content.push({ type: "reasoning", text } as LanguageModelV2Content)
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
  // § 3  Token refresh
  // ---------------------------------------------------------------------------

  private async ensureValidToken(): Promise<void> {
    const creds = this.options.credentials
    if (creds.access && creds.expires && creds.expires > Date.now()) return

    const tokens = await refreshTokenWithMutex(creds.refresh)
    if (tokens === null) {
      // Permanent (4xx) refresh failure. Persist dead-state via onTokenRefresh
      // (clear refresh) so any subsequent refreshIfNeeded short-circuits, then
      // surface a clear auth error to the request caller.
      creds.refresh = ""
      creds.access = ""
      creds.expires = 0
      if (this.options.onTokenRefresh) await this.options.onTokenRefresh(creds)
      throw new Error("codex auth: refresh_token revoked — re-login required")
    }
    creds.access = tokens.access_token
    creds.expires = Date.now() + (tokens.expires_in ?? 3600) * 1000
    if (tokens.refresh_token) creds.refresh = tokens.refresh_token

    if (this.options.onTokenRefresh) {
      await this.options.onTokenRefresh(creds)
    }
  }

  // ---------------------------------------------------------------------------
  // § 4  Compaction support
  // ---------------------------------------------------------------------------

  /** Advance window generation after compaction */
  advanceWindowGeneration() {
    this.window.generation++
    if (this.options.sessionId) {
      resetWsSession(this.options.sessionId)
    }
  }

  /** Reset turn state for new user message */
  resetTurnState() {
    this.turnState = undefined
  }
}
