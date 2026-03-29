/**
 * Codex WebSocket Transport Adapter
 *
 * Transport adapter beneath the AI SDK contract (per specs/codex/provider_runtime/ DD-1, DD-4).
 * Produces a synthetic SSE Response that AI SDK consumes identically to HTTP.
 *
 * Reference: refs/codex/codex-rs/codex-api/src/endpoint/responses_websocket.rs
 */

import { Log } from "../util/log"

const log = Log.create({ service: "codex-websocket" })

// ── Constants ──

const WS_CONNECT_TIMEOUT_MS = 15_000
const WS_IDLE_TIMEOUT_MS = 30_000
const WS_MAX_CONNECT_RETRIES = 1 // retry once, then HTTP fallback

// ── Types ──

export interface WsSessionState {
  ws: WebSocket | null
  status: "idle" | "connecting" | "open" | "streaming" | "failed"
  accountId?: string
  lastResponseId?: string
  lastInputLength?: number
  disableWebsockets: boolean
}

interface WrappedWebsocketError {
  type?: string
  code?: string
  message?: string
  plan_type?: string
  resets_at?: number
}

interface WrappedWebsocketErrorEvent {
  type: string
  status?: number
  error?: WrappedWebsocketError
  headers?: Record<string, unknown>
}

// ── Session State ──

const sessions = new Map<string, WsSessionState>()

export function getWsSession(sessionId: string): WsSessionState {
  let state = sessions.get(sessionId)
  if (!state) {
    state = { ws: null, status: "idle", disableWebsockets: false }
    sessions.set(sessionId, state)
  }
  return state
}

export function closeWsSession(sessionId: string) {
  const state = sessions.get(sessionId)
  if (state?.ws) {
    try { state.ws.close() } catch {}
    state.ws = null
    state.status = "idle"
  }
}

// ── Error Parsing (Phase 2A: codex-rs responses_websocket.rs lines 446-507) ──

function parseWrappedWebsocketErrorEvent(data: string): WrappedWebsocketErrorEvent | null {
  try {
    const event = JSON.parse(data) as WrappedWebsocketErrorEvent
    if (event.type !== "error") return null
    return event
  } catch {
    return null
  }
}

function mapWrappedWebsocketErrorEvent(event: WrappedWebsocketErrorEvent, rawPayload: string): Error | null {
  const errorCode = event.error?.code
  const errorMessage = event.error?.message || event.error?.type || "Unknown Codex WS error"

  // websocket_connection_limit_reached → retryable (reconnect)
  if (errorCode === "websocket_connection_limit_reached") {
    return new Error(`Codex WS: connection limit reached (60 min). Reconnecting...`)
  }

  // Error with HTTP status → transport error (rotation handles)
  if (event.status) {
    const status = event.status
    // Extract extra info for rate limit errors
    const planType = event.error?.plan_type ? ` (plan: ${event.error.plan_type})` : ""
    return new Error(`Codex API error (${status}): ${errorMessage}${planType}`)
  }

  // Error WITHOUT status → ignore (codex-rs test: line 780-798)
  return null
}

// ── Header Builder (Task 1.2) ──

export function buildWsHeaders(input: {
  accessToken: string
  accountId?: string
  turnState?: string
}): Record<string, string> {
  const headers: Record<string, string> = {
    "Authorization": `Bearer ${input.accessToken}`,
    "originator": "opencode",
    "OpenAI-Beta": "responses_websockets=2026-02-06",
  }
  if (input.accountId) headers["chatgpt-account-id"] = input.accountId
  if (input.turnState) headers["x-codex-turn-state"] = input.turnState
  return headers
}

// ── WS Connection (Task 1.3) ──

export function connectWs(url: string, headers: Record<string, string>): Promise<WebSocket | null> {
  log.info("ws connecting", { url })
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      log.warn("ws connect timeout", { url })
      try { ws.close() } catch {}
      resolve(null)
    }, WS_CONNECT_TIMEOUT_MS)

    let ws: WebSocket
    try {
      ws = new WebSocket(url, { headers } as any)
    } catch (e) {
      clearTimeout(timeout)
      log.warn("ws constructor failed", { error: String(e) })
      resolve(null)
      return
    }

    ws.onopen = () => {
      clearTimeout(timeout)
      log.info("ws connected", { url })
      resolve(ws)
    }

    ws.onerror = (e: any) => {
      clearTimeout(timeout)
      log.warn("ws connect error", { error: e?.message || String(e) })
      resolve(null)
    }

    ws.onclose = () => {
      clearTimeout(timeout)
      // If onopen never fired, this is a connect failure
      resolve(null)
    }
  })
}

// ── WS Request + Synthetic SSE Response (Tasks 1.4-1.6, 2.4-2.7, 3.1-3.5) ──

export function wsRequest(input: {
  ws: WebSocket
  body: Record<string, unknown>
  sessionId: string
  state: WsSessionState
}): Response {
  const { ws, body, sessionId, state } = input
  const encoder = new TextEncoder()

  // Strip transport-specific fields not valid in WS mode
  const { stream: _s, background: _b, ...wsBody } = body

  // Phase 3: Incremental delta — trim input if previous_response_id is set
  const fullInputLength = Array.isArray(wsBody.input) ? wsBody.input.length : 0
  let deltaMode = false
  if (wsBody.previous_response_id && Array.isArray(wsBody.input)) {
    const lastLen = state.lastInputLength ?? 0
    if (lastLen > 0 && wsBody.input.length > lastLen) {
      wsBody.input = wsBody.input.slice(lastLen)
      deltaMode = true
    }
  }
  // Track full input length for next delta
  state.lastInputLength = fullInputLength

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let frameCount = 0
      let idleTimer: ReturnType<typeof setTimeout> | null = null

      function resetIdleTimer() {
        if (idleTimer) clearTimeout(idleTimer)
        idleTimer = setTimeout(() => {
          log.warn("ws idle timeout", { sessionId, frameCount })
          controller.error(new Error("Codex WS: idle timeout waiting for response"))
          state.status = "failed"
          cleanup()
        }, WS_IDLE_TIMEOUT_MS)
      }

      function cleanup() {
        if (idleTimer) clearTimeout(idleTimer)
        ws.onmessage = null
        ws.onerror = null
        ws.onclose = null
      }

      function endStream() {
        cleanup()
        try {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"))
          controller.close()
        } catch {}
        state.status = "open" // ready for next request
      }

      function endWithError(err: Error) {
        cleanup()
        state.status = "failed"
        try { controller.error(err) } catch {}
      }

      // ── Message handler ──
      ws.onmessage = (event: MessageEvent) => {
        const data = typeof event.data === "string" ? event.data : ""
        if (!data) return
        frameCount++
        resetIdleTimer()

        // Phase 2A: Error-first parsing (check WrappedWebsocketErrorEvent BEFORE ResponsesStreamEvent)
        const errorEvent = parseWrappedWebsocketErrorEvent(data)
        if (errorEvent) {
          const mapped = mapWrappedWebsocketErrorEvent(errorEvent, data)
          if (mapped) {
            log.warn("ws error event", { sessionId, error: mapped.message })
            // Phase 3: Evict cache on error
            state.lastResponseId = undefined
            state.lastInputLength = undefined
            endWithError(mapped)
            return
          }
          // No-status error → ignored per codex-rs behavior, but still forward as SSE data
        }

        // Forward as SSE data line for AI SDK consumption
        controller.enqueue(encoder.encode(`data: ${data}\n\n`))

        // Detect stream end events
        try {
          const parsed = JSON.parse(data)
          const eventType = parsed.type as string

          // Phase 3: Capture response_id from completed event
          if (eventType === "response.completed") {
            const responseId = parsed.response?.id
            if (responseId) {
              state.lastResponseId = responseId
              log.info("ws captured responseId", { sessionId, responseId: responseId.slice(0, 16) + "..." })
            }
            endStream()
            return
          }

          // response.incomplete is also a terminal event
          if (eventType === "response.incomplete") {
            log.warn("ws response incomplete", { sessionId, reason: parsed.response?.incomplete_details?.reason })
            endStream()
            return
          }

          // response.failed → extract error info and terminate
          if (eventType === "response.failed") {
            const errMsg = parsed.response?.error?.message || "Response failed"
            log.warn("ws response failed", { sessionId, error: errMsg })
            state.lastResponseId = undefined
            endWithError(new Error(`Codex: ${errMsg}`))
            return
          }
        } catch {
          // JSON parse error — continue, AI SDK will handle or ignore
        }
      }

      // ── Error/Close handlers ──
      ws.onerror = () => {
        log.warn("ws error during stream", { sessionId, frameCount })
        state.status = "failed"
        endWithError(new Error("WebSocket error during streaming"))
      }

      ws.onclose = (event: CloseEvent) => {
        if (state.status === "streaming") {
          log.warn("ws closed during stream", { sessionId, frameCount, code: event?.code, reason: event?.reason })
          state.status = "failed"
          if (frameCount === 0) {
            endWithError(new Error("Codex WS: connection closed before any response"))
          } else {
            // Some frames received but no response.completed — close stream gracefully
            // AI SDK will see finishReason from whatever events arrived
            try { controller.close() } catch {}
          }
        }
      }

      // ── Send request ──
      state.status = "streaming"
      resetIdleTimer()

      const payload = JSON.stringify({ type: "response.create", ...wsBody })
      log.info("ws request sent", { sessionId, deltaMode, inputItems: Array.isArray(wsBody.input) ? wsBody.input.length : 0, fullItems: fullInputLength })
      ws.send(payload)
    },
  })

  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream; charset=utf-8" },
  })
}

// ── Transport Decision (Task 1.7, Phase 2B) ──

export async function tryWsTransport(input: {
  sessionId: string
  accessToken: string
  accountId?: string
  turnState?: string
  body: Record<string, unknown>
  wsUrl: string
}): Promise<Response | null> {
  const { sessionId, accessToken, accountId, body, wsUrl } = input
  const state = getWsSession(sessionId)

  // Sticky fallback: once disabled, stay disabled for session lifetime
  if (state.disableWebsockets) return null

  // Account-aware lifecycle: reconnect if account changed
  if (state.ws && state.status === "open" && state.accountId !== accountId) {
    log.info("ws account changed, reconnecting", { sessionId, old: state.accountId, new: accountId })
    try { state.ws.close() } catch {}
    state.ws = null
    state.status = "idle"
  }

  // Reuse existing open connection
  if (state.ws && state.status === "open") {
    // Phase 3: Inject previous_response_id if available
    const reqBody = { ...body }
    if (state.lastResponseId && !reqBody.previous_response_id) {
      reqBody.previous_response_id = state.lastResponseId
    }

    try {
      return wsRequest({ ws: state.ws, body: reqBody, sessionId, state })
    } catch (e) {
      log.warn("ws request failed on cached connection", { sessionId, error: String(e) })
      state.ws = null
      state.status = "failed"
      // Fall through to reconnect
    }
  }

  // Connect (with retry)
  const headers = buildWsHeaders({ accessToken, accountId, turnState: input.turnState })

  for (let attempt = 0; attempt <= WS_MAX_CONNECT_RETRIES; attempt++) {
    if (attempt > 0) log.info("ws connect retry", { sessionId, attempt })

    const ws = await connectWs(wsUrl, headers)
    if (ws) {
      state.ws = ws
      state.status = "open"
      state.accountId = accountId

      // Phase 3: Inject previous_response_id
      const reqBody = { ...body }
      if (state.lastResponseId && !reqBody.previous_response_id) {
        reqBody.previous_response_id = state.lastResponseId
      }

      try {
        return wsRequest({ ws, body: reqBody, sessionId, state })
      } catch (e) {
        log.warn("ws request failed on new connection", { sessionId, error: String(e) })
        state.ws = null
        state.status = "failed"
        continue
      }
    }
  }

  // All attempts failed → activate sticky HTTP fallback
  log.warn("ws fallback to HTTP", { sessionId, retries: WS_MAX_CONNECT_RETRIES })
  state.disableWebsockets = true
  state.ws = null
  state.status = "failed"
  return null
}
