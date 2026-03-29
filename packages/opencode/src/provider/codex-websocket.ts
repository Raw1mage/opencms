/**
 * codex-websocket.ts — WebSocket transport for Codex Responses API
 *
 * Provides incremental delta and prewarm capabilities:
 *   - previous_response_id: only send new input items (not full history)
 *   - generate: false: warm server cache without output token consumption
 *   - Sticky routing via x-codex-turn-state header
 *
 * Falls back to HTTP SSE (Bun.spawn C binary) on connection failure.
 */

import { Log } from "../util/log"
import type { LanguageModelV2StreamPart, LanguageModelV2FinishReason, LanguageModelV2Usage } from "@ai-sdk/provider"

const log = Log.create({ service: "codex-websocket" })

const CODEX_WS_ENDPOINT = "wss://chatgpt.com/backend-api/codex/responses"
const WS_BETA_HEADER = "responses_websockets=2026-02-06"
const CONNECT_TIMEOUT_MS = 15000
const CONNECTION_MAX_AGE_MS = 55 * 60 * 1000 // 55 min (server limit is 60)

export interface CodexWsAuth {
  accessToken: string
  accountId?: string
}

export interface CodexWsRequest {
  type: "response.create"
  model: string
  instructions: string
  input: unknown[]
  tools: unknown[]
  tool_choice: string
  parallel_tool_calls: boolean
  stream: boolean
  include: string[]
  prompt_cache_key?: string
  previous_response_id?: string
  generate?: boolean
}

interface WsEventHandler {
  onPart: (part: LanguageModelV2StreamPart) => void
  onMeta: (meta: { turnState?: string; responseId?: string; reasoningIncluded?: boolean }) => void
  onItem: (item: unknown) => void
  onDone: () => void
  onError: (err: Error) => void
}

/**
 * Non-input fields of a request, used for delta comparison.
 * Matches codex-rs: clone request, clear input, compare equality.
 */
interface RequestSignature {
  model: string
  instructions: string
  tools: unknown[]
  tool_choice: string
  parallel_tool_calls: boolean
  include: string[]
}

function extractSignature(req: CodexWsRequest): RequestSignature {
  return {
    model: req.model,
    instructions: req.instructions,
    tools: req.tools,
    tool_choice: req.tool_choice,
    parallel_tool_calls: req.parallel_tool_calls,
    include: req.include,
  }
}

/** Sort tools by name for order-independent comparison */
function normalizeTools(tools: unknown[]): string {
  const sorted = [...tools].sort((a: any, b: any) =>
    (a?.name ?? "").localeCompare(b?.name ?? ""),
  )
  return JSON.stringify(sorted)
}

function signaturesEqual(a: RequestSignature, b: RequestSignature): boolean {
  return (
    a.model === b.model &&
    a.instructions === b.instructions &&
    a.tool_choice === b.tool_choice &&
    a.parallel_tool_calls === b.parallel_tool_calls &&
    normalizeTools(a.tools) === normalizeTools(b.tools) &&
    JSON.stringify([...a.include].sort()) === JSON.stringify([...b.include].sort())
  )
}

/**
 * Manages a WebSocket connection to the Codex Responses API.
 * Reusable across multiple requests within a session.
 */
export class CodexWebSocket {
  private ws: WebSocket | null = null
  private connected = false
  private connectedAt = 0
  /** Track which content streams have been started (text-start/reasoning-start sent) */
  private startedStreams = new Set<string>()
  private handler: WsEventHandler | null = null
  private lastResponseId: string | undefined
  private disabled = false

  // Delta detection state (mirrors codex-rs websocket_session)
  private lastRequest: CodexWsRequest | null = null
  private lastResponseItems: unknown[] = []

  constructor(
    private auth: CodexWsAuth,
    private originator?: string,
    private turnState?: string,
  ) {}

  get isDisabled() { return this.disabled }

  /** Update auth tokens (call before each request to handle token refresh) */
  updateAuth(auth: CodexWsAuth) {
    this.auth = auth
  }

  /**
   * Connect to WebSocket endpoint.
   * Reconnects with fresh auth if previous connection closed.
   * Returns true if connected, false if should fallback to HTTP.
   */
  async connect(): Promise<boolean> {
    if (this.disabled) return false
    if (this.ws && this.connected && !this.isExpired()) return true

    // Reconnecting — clear delta state (codex-rs: needs_new clears last_request/last_response_rx)
    this.close()
    this.lastRequest = null
    this.lastResponseItems = []

    return new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        log.warn("codex ws connect timeout")
        this.disable("connect timeout")
        resolve(false)
      }, CONNECT_TIMEOUT_MS)

      try {
        // Bun WebSocket client supports headers via second arg
        this.ws = new WebSocket(CODEX_WS_ENDPOINT, {
          headers: {
            "Authorization": `Bearer ${this.auth.accessToken}`,
            "OpenAI-Beta": WS_BETA_HEADER,
            "originator": this.originator ?? "codex_cli_rs/0.1.0",
            ...(this.auth.accountId ? { "chatgpt-account-id": this.auth.accountId } : {}),
            ...(this.turnState ? { "x-codex-turn-state": this.turnState } : {}),
          },
        } as any)

        this.ws.onopen = () => {
          clearTimeout(timeout)
          this.connected = true
          this.connectedAt = Date.now()
          log.info("codex ws connected")
          resolve(true)
        }

        this.ws.onmessage = (event) => {
          this.handleMessage(typeof event.data === "string" ? event.data : "")
        }

        this.ws.onerror = (event) => {
          clearTimeout(timeout)
          log.warn("codex ws error", { error: String(event) })
          if (!this.connected) {
            this.disable("connect error")
            resolve(false)
          }
        }

        this.ws.onclose = (event) => {
          clearTimeout(timeout)
          this.connected = false
          if (event.code === 426) {
            this.disable("426 Upgrade Required")
            resolve(false)
          }
          // Notify handler if mid-stream
          if (this.handler) {
            this.handler.onDone()
            this.handler = null
          }
        }
      } catch (err) {
        clearTimeout(timeout)
        log.warn("codex ws create failed", { error: String(err) })
        this.disable("create failed")
        resolve(false)
      }
    })
  }

  /**
   * Send a request and stream events.
   * Automatically applies incremental delta when possible.
   * Returns a ReadableStream of LanguageModelV2StreamPart.
   */
  async stream(request: CodexWsRequest): Promise<ReadableStream<LanguageModelV2StreamPart> | null> {
    if (!this.ws || !this.connected) return null

    // Prepare the actual wire request (may be delta)
    const wireRequest = this.prepareWireRequest(request)

    // Track this request for next delta computation
    this.lastRequest = { ...request }
    this.lastResponseItems = []

    return new ReadableStream<LanguageModelV2StreamPart>({
      start: (controller) => {
        this.handler = {
          onPart: (part) => controller.enqueue(part),
          onMeta: (meta) => {
            if (meta.turnState) this.turnState = meta.turnState
            if (meta.responseId) this.lastResponseId = meta.responseId
          },
          onItem: (item) => {
            // Collect server-returned items for delta baseline
            this.lastResponseItems.push(item)
          },
          onDone: () => {
            this.handler = null
            controller.close()
          },
          onError: (err) => {
            this.handler = null
            controller.error(err)
          },
        }

        // Send request as text frame
        try {
          this.ws!.send(JSON.stringify(wireRequest))
        } catch (err) {
          this.handler.onError(err instanceof Error ? err : new Error(String(err)))
        }
      },

      cancel: () => {
        this.handler = null
      },
    })
  }

  /**
   * Prewarm: send request with generate=false to warm server cache.
   * Does not consume output tokens. Stores request for delta baseline.
   */
  async prewarm(request: Omit<CodexWsRequest, "generate">): Promise<boolean> {
    if (!this.ws || !this.connected) return false

    // Store as last request for delta computation (prewarm is the baseline)
    this.lastRequest = { ...request, generate: false } as CodexWsRequest
    this.lastResponseItems = []

    return new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        this.handler = null
        resolve(false)
      }, 30000)

      this.handler = {
        onPart: () => {}, // ignore parts during prewarm
        onMeta: (meta) => {
          if (meta.turnState) this.turnState = meta.turnState
          if (meta.responseId) this.lastResponseId = meta.responseId
        },
        onItem: (item) => {
          this.lastResponseItems.push(item)
        },
        onDone: () => {
          clearTimeout(timeout)
          this.handler = null
          log.info("codex ws prewarm complete", { responseId: this.lastResponseId })
          resolve(true)
        },
        onError: () => {
          clearTimeout(timeout)
          this.handler = null
          resolve(false)
        },
      }

      try {
        this.ws!.send(JSON.stringify({ ...request, generate: false }))
      } catch {
        clearTimeout(timeout)
        this.handler = null
        resolve(false)
      }
    })
  }

  /**
   * Prepare wire request with incremental delta when possible.
   * Mirrors codex-rs get_incremental_items() + prepare_websocket_request():
   *   1. Compare non-input fields (instructions, tools, model, etc.)
   *   2. Build baseline = previous input + server-returned items
   *   3. Check current input is strict extension of baseline
   *   4. Send only new items with previous_response_id
   */
  private prepareWireRequest(request: CodexWsRequest): CodexWsRequest {
    if (!this.lastRequest || !this.lastResponseId) return request

    // Step 1: non-input field comparison
    const prevSig = extractSignature(this.lastRequest)
    const currSig = extractSignature(request)
    if (!signaturesEqual(prevSig, currSig)) {
      log.info("codex ws delta rejected: non-input fields changed")
      return request
    }

    // Step 2: build baseline (previous input + server-returned items)
    const baseline = [...this.lastRequest.input, ...this.lastResponseItems]
    const baselineLen = baseline.length

    // Step 3: check current input is strict extension
    if (request.input.length <= baselineLen) return request

    // Verify prefix match (items must be identical)
    const baselineJson = JSON.stringify(baseline)
    const prefixJson = JSON.stringify(request.input.slice(0, baselineLen))
    if (baselineJson !== prefixJson) {
      log.info("codex ws delta rejected: input prefix mismatch")
      return request
    }

    // Step 4: send only delta items
    const deltaItems = request.input.slice(baselineLen)
    log.info("codex ws incremental delta", {
      baselineItems: baselineLen,
      deltaItems: deltaItems.length,
      totalItems: request.input.length,
      previousResponseId: this.lastResponseId,
    })

    return {
      ...request,
      input: deltaItems,
      previous_response_id: this.lastResponseId,
    }
  }

  get responseId() { return this.lastResponseId }

  close() {
    if (this.ws) {
      try { this.ws.close() } catch {}
      this.ws = null
    }
    this.connected = false
    this.handler = null
  }

  private isExpired(): boolean {
    return Date.now() - this.connectedAt > CONNECTION_MAX_AGE_MS
  }

  private disable(reason: string) {
    log.warn("codex ws disabled, falling back to HTTP", { reason })
    this.disabled = true
    this.close()
  }

  private handleMessage(data: string) {
    if (!this.handler) return

    let event: any
    try {
      event = JSON.parse(data)
    } catch {
      log.warn("codex ws unparseable message", { preview: data.slice(0, 200) })
      return
    }

    const type = event.type as string
    if (!type) {
      log.warn("codex ws event missing type", { keys: Object.keys(event).join(","), preview: data.slice(0, 200) })
      return
    }

    // Verbose event log — only for debugging, disable in production
    // log.info("codex ws event", { type, preview: data.slice(0, 500) })

    switch (type) {
      case "response.created": {
        const id = event.response?.id
        if (id) this.handler.onMeta({ responseId: id })
        this.handler.onPart({ type: "stream-start", warnings: [] })
        break
      }

      case "response.output_text.delta": {
        if (event.delta) {
          if (!this.startedStreams.has("text-0")) {
            this.startedStreams.add("text-0")
            this.handler.onPart({ type: "text-start", id: "text-0" })
          }
          this.handler.onPart({ type: "text-delta", delta: event.delta, id: "text-0" })
        }
        break
      }

      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta": {
        if (event.delta) {
          if (!this.startedStreams.has("reasoning-0")) {
            this.startedStreams.add("reasoning-0")
            this.handler.onPart({ type: "reasoning-start", id: "reasoning-0" })
          }
          this.handler.onPart({ type: "reasoning-delta", delta: event.delta, id: "reasoning-0" })
        }
        break
      }

      case "response.output_item.added": {
        const item = event.item
        if (!item) break
        if (item.type === "function_call") {
          this.handler.onPart({
            type: "tool-input-start",
            id: item.call_id ?? `tool-${Date.now()}`,
            toolName: item.name ?? "",
          })
        }
        break
      }

      case "response.function_call_arguments.delta": {
        if (event.delta && event.item_id) {
          this.handler.onPart({
            type: "tool-input-delta",
            id: event.item_id,
            delta: event.delta,
          })
        }
        break
      }

      case "response.function_call_arguments.done": {
        // Handled by response.output_item.done which has the full item
        break
      }

      case "response.reasoning_summary_part.added": {
        this.handler.onPart({
          type: "reasoning-start",
          id: `reasoning-${event.part_index ?? 0}`,
        })
        break
      }

      case "response.output_item.done": {
        const item = event.item
        if (!item) break

        // Track server-returned items for delta baseline
        this.handler.onItem(item)

        if (item.type === "function_call") {
          this.handler.onPart({
            type: "tool-call",
            toolCallId: item.call_id ?? `tool-${Date.now()}`,
            toolName: item.name ?? "",
            input: item.arguments ?? "{}",
          })
        }
        break
      }

      case "response.completed": {
        const resp = event.response
        const id = resp?.id
        const usage = resp?.usage
        if (id) this.handler.onMeta({ responseId: id })

        // Close any open content streams before finish
        if (this.startedStreams.has("text-0")) {
          this.handler.onPart({ type: "text-end", id: "text-0" })
        }
        if (this.startedStreams.has("reasoning-0")) {
          this.handler.onPart({ type: "reasoning-end", id: "reasoning-0" })
        }
        this.startedStreams.clear()

        // Capture turn state from headers if present
        // (WebSocket frames don't have HTTP headers, but the completed event may have metadata)
        if (event.headers) {
          const ts = event.headers["x-codex-turn-state"]
          if (ts) this.handler.onMeta({ turnState: ts })
        }

        const inp = usage?.input_tokens ?? 0
        const out = usage?.output_tokens ?? 0
        const u: LanguageModelV2Usage = {
          inputTokens: inp,
          outputTokens: out,
          totalTokens: inp + out,
        }
        this.handler.onPart({
          type: "finish",
          usage: u,
          finishReason: "stop" as LanguageModelV2FinishReason,
        })
        this.handler.onDone()
        break
      }

      case "response.failed": {
        const err = event.response?.error
        this.handler.onPart({
          type: "error",
          error: new Error(err?.message ?? "Request failed"),
        })
        this.handler.onPart({
          type: "finish",
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          finishReason: "error" as LanguageModelV2FinishReason,
        })
        this.handler.onDone()
        break
      }

      case "response.incomplete": {
        this.handler.onPart({
          type: "finish",
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          finishReason: "length" as LanguageModelV2FinishReason,
        })
        this.handler.onDone()
        break
      }

      case "codex.rate_limits": {
        // Rate limit info from server — log for observability, not a stream part
        log.info("codex ws rate limits", {
          planType: event.plan_type,
          primaryUsed: event.rate_limits?.primary?.used_percent,
          secondaryUsed: event.rate_limits?.secondary?.used_percent,
        })
        break
      }

      case "error": {
        // Top-level error (not response.failed) — server rejected the request
        const msg = event.message ?? event.error?.message ?? JSON.stringify(event)
        log.warn("codex ws server error", { message: msg, code: event.code, preview: data.slice(0, 500) })
        this.handler.onPart({
          type: "error",
          error: new Error(msg),
        })
        this.handler.onPart({
          type: "finish",
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          finishReason: "error" as LanguageModelV2FinishReason,
        })
        this.handler.onDone()
        break
      }

      default: {
        log.info("codex ws unhandled event type", { type })
        break
      }
    }
  }
}
