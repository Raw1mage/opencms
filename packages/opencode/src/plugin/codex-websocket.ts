/**
 * Codex WebSocket Transport Adapter
 *
 * Transport adapter beneath the AI SDK contract (per specs/codex/provider_runtime/ DD-1, DD-4).
 * Produces a synthetic SSE Response that AI SDK consumes identically to HTTP.
 *
 * Reference: refs/codex/codex-rs/codex-api/src/endpoint/responses_websocket.rs
 */

import { Log } from "../util/log"
import { Global } from "../global"
import path from "path"
import { existsSync, readFileSync, writeFileSync } from "fs"

const log = Log.create({ service: "codex-websocket" })

// ── Constants ──

const WS_CONNECT_TIMEOUT_MS = 15_000
const WS_IDLE_TIMEOUT_MS = 30_000
const WS_FIRST_FRAME_TIMEOUT_MS = 10_000 // must receive first frame within 10s or fallback
const WS_MAX_CONNECT_RETRIES = 1 // retry once, then HTTP fallback

// ── Types ──

export interface WsSessionState {
  ws: WebSocket | null
  status: "idle" | "connecting" | "open" | "streaming" | "failed"
  accountId?: string
  lastResponseId?: string
  lastInputLength?: number
  disableWebsockets: boolean
  /** Set when server rejects previous_response_id — signals that the next
   *  request was a full-context rebind and local compaction should be scheduled. */
  continuationInvalidated?: boolean
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

// ── Session State (with file-backed continuation persistence) ──

const sessions = new Map<string, WsSessionState>()

// Persisted continuation state survives daemon restarts.
// Only lastResponseId and lastInputLength are persisted — WS connection
// and transient flags (status, disableWebsockets) reset on restart.
interface PersistedContinuation {
  [sessionId: string]: { lastResponseId?: string; lastInputLength?: number; accountId?: string }
}

const CONTINUATION_FILE = path.join(Global.Path.state, "ws-continuation.json")
let _continuationCache: PersistedContinuation | null = null
let _continuationDirty = false
let _continuationFlushTimer: ReturnType<typeof setTimeout> | null = null

function loadContinuation(): PersistedContinuation {
  if (_continuationCache) return _continuationCache
  try {
    if (existsSync(CONTINUATION_FILE)) {
      _continuationCache = JSON.parse(readFileSync(CONTINUATION_FILE, "utf-8"))
      return _continuationCache!
    }
  } catch {
    log.warn("failed to load ws-continuation.json, starting fresh")
  }
  _continuationCache = {}
  return _continuationCache
}

function saveContinuation() {
  _continuationDirty = true
  if (_continuationFlushTimer) return
  // Debounce writes to avoid thrashing disk on every streaming chunk
  _continuationFlushTimer = setTimeout(() => {
    _continuationFlushTimer = null
    if (!_continuationDirty || !_continuationCache) return
    _continuationDirty = false
    try {
      writeFileSync(CONTINUATION_FILE, JSON.stringify(_continuationCache, null, 2))
    } catch (e) {
      log.warn("failed to save ws-continuation.json", { error: String(e) })
    }
  }, 2000)
}

export function getWsSession(sessionId: string): WsSessionState {
  let state = sessions.get(sessionId)
  if (!state) {
    // Restore continuation state from disk
    const persisted = loadContinuation()[sessionId]
    state = {
      ws: null,
      status: "idle",
      disableWebsockets: false,
      lastResponseId: persisted?.lastResponseId,
      lastInputLength: persisted?.lastInputLength,
      accountId: persisted?.accountId,
    }
    if (persisted?.lastResponseId) {
      log.info("ws continuation restored from disk", {
        sessionId,
        responseId: persisted.lastResponseId.slice(0, 16) + "...",
        lastInputLength: persisted.lastInputLength,
      })
    }
    sessions.set(sessionId, state)
  }
  return state
}

/** Persist continuation-relevant fields to disk (debounced). */
export function persistWsSession(sessionId: string, state: WsSessionState) {
  const cont = loadContinuation()
  cont[sessionId] = {
    lastResponseId: state.lastResponseId,
    lastInputLength: state.lastInputLength,
    accountId: state.accountId,
  }
  saveContinuation()
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
          const reason = frameCount === 0 ? "first_frame_timeout" : "mid_stream_stall"
          log.warn(`ws ${reason}`, { sessionId, frameCount })
          invalidateContinuation(reason as InvalidationReason)
          if (frameCount === 0) {
            // No frames yet — error won't leak (probe hasn't passed)
            controller.error(new Error(`Codex WS: ${reason}`))
            state.status = "failed"
            cleanup()
          } else {
            // Frames already received — probe passed, controller.error() would
            // leak into AI SDK as visible text. Close gracefully instead.
            endStream()
          }
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

      /** Invalidate continuation state with a typed reason and persist. */
      type InvalidationReason = "first_frame_timeout" | "mid_stream_stall" | "close_before_completion"
        | "response_failed" | "ws_error" | "previous_response_not_found"

      function invalidateContinuation(reason: InvalidationReason) {
        const had = !!state.lastResponseId
        state.lastResponseId = undefined
        state.lastInputLength = undefined
        persistWsSession(sessionId, state)
        if (had) {
          console.error(`[CONTINUATION] ${reason} session=${sessionId} (cleared)`)
        }
      }

      // ── Message handler ──
      ws.onmessage = (event: MessageEvent) => {
        const data = typeof event.data === "string" ? event.data : ""
        if (!data) return
        frameCount++
        resetIdleTimer()

        // Trace every frame for debugging
        try {
          const parsed = JSON.parse(data)
          const t = parsed.type
          if (t === "codex.rate_limits") {
            // Metadata-only frame: log but do NOT forward to SSE stream.
            // Consistent with codex-rs (responses_websocket.rs:608-613).
            // If forwarded, it would pass first-frame probe as "content",
            // preventing error events from being caught before commit.
            console.error(`[WS-RATE-LIMITS] session=${sessionId} ${data}`)
            return
          }
          console.error(`[WS-FRAME] #${frameCount} type=${t} session=${sessionId} len=${data.length}`)
        } catch {
          console.error(`[WS-FRAME] #${frameCount} raw session=${sessionId} len=${data.length}`)
        }

        // Phase 2A: Error-first parsing (check WrappedWebsocketErrorEvent BEFORE ResponsesStreamEvent)
        const errorEvent = parseWrappedWebsocketErrorEvent(data)
        if (errorEvent) {
          const mapped = mapWrappedWebsocketErrorEvent(errorEvent, data)
          const errorMsg = mapped?.message || errorEvent.error?.message || errorEvent.error?.type || "Unknown WS error"
          const errorCode = errorEvent.error?.code || errorEvent.error?.type || ""
          const isPrevRespNotFound = errorCode.includes("previous_response") ||
            errorMsg.includes("Previous response") || errorMsg.includes("not found")

          if (isPrevRespNotFound) {
            log.warn("ws continuation invalidated: previous_response_not_found", { sessionId })
            invalidateContinuation("previous_response_not_found")
            state.continuationInvalidated = true
            // End the stream with an error that tryWsTransport / probeFirstFrame
            // will catch, causing WS to return null → HTTP fallback with full context.
            // This error is caught BEFORE reaching AI SDK, so it won't leak as text.
            cleanup()
            state.status = "failed"
            try { controller.error(new Error("CONTINUATION_INVALIDATED")) } catch {}
            return
          }

          log.warn("ws error event", { sessionId, error: errorMsg, hasStatus: !!errorEvent.status })
          invalidateContinuation("ws_error")
          endWithError(mapped || new Error(`Codex WS: ${errorMsg}`))
          return
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
              persistWsSession(sessionId, state)
              console.error(`[CONTINUATION] bound session=${sessionId} responseId=${responseId.slice(0, 20)}...`)
            }
            endStream()
            return
          }

          // response.incomplete — turn did not finish; continuation pointer is unreliable
          if (eventType === "response.incomplete") {
            log.warn("ws response incomplete", { sessionId, reason: parsed.response?.incomplete_details?.reason })
            invalidateContinuation("close_before_completion")
            endStream()
            return
          }

          // response.failed → extract error info, invalidate continuation, terminate
          if (eventType === "response.failed") {
            const errMsg = parsed.response?.error?.message || "Response failed"
            log.warn("ws response failed", { sessionId, error: errMsg })
            invalidateContinuation("response_failed")
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
        invalidateContinuation("ws_error")
        if (frameCount === 0) {
          endWithError(new Error("WebSocket error during streaming"))
        } else {
          // Frames already received — graceful close to avoid error text leaking
          endStream()
        }
      }

      ws.onclose = (event: CloseEvent) => {
        if (state.status === "streaming") {
          log.warn("ws closed during stream", { sessionId, frameCount, code: event?.code, reason: event?.reason })
          invalidateContinuation("close_before_completion")
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
      const inputItems = Array.isArray(wsBody.input) ? wsBody.input.length : 0
      // Payload breakdown: measure each top-level field's contribution
      const breakdown: Record<string, number> = {}
      for (const [k, v] of Object.entries(wsBody)) {
        breakdown[k] = JSON.stringify(v).length
      }
      console.error(`[DELTA-REQ] session=${sessionId} delta=${deltaMode} inputItems=${inputItems} fullItems=${fullInputLength} payloadBytes=${payload.length} hasPrevResp=${!!wsBody.previous_response_id}`)
      console.error(`[DELTA-BREAKDOWN] ${Object.entries(breakdown).sort((a,b) => b[1]-a[1]).map(([k,v]) => `${k}=${v}`).join(' ')}`)
      log.info("ws request sent", { sessionId, deltaMode, inputItems, fullItems: fullInputLength, payloadBytes: payload.length, hasPrevResp: !!wsBody.previous_response_id })
      ws.send(payload)
    },
  })

  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream; charset=utf-8" },
  })
}

// ── First-Frame Probe ──
// Wait for the first SSE chunk from the WS response before committing.
// If no data within WS_FIRST_FRAME_TIMEOUT_MS, return null → HTTP fallback.

async function probeFirstFrame(response: Response, sessionId: string, state: WsSessionState): Promise<Response | null> {
  const reader = response.body!.getReader()

  const result = await Promise.race([
    reader.read(),
    new Promise<{ timeout: true }>((resolve) =>
      setTimeout(() => resolve({ timeout: true }), WS_FIRST_FRAME_TIMEOUT_MS)
    ),
  ]) as any

  if (result.timeout) {
    log.warn("ws first-frame timeout, falling back to HTTP", { sessionId })
    reader.cancel()
    // Invalidate continuation — request outcome is ambiguous
    state.lastResponseId = undefined
    state.lastInputLength = undefined
    persistWsSession(sessionId, state)
    console.error(`[CONTINUATION] first_frame_timeout session=${sessionId} (cleared)`)
    state.disableWebsockets = true
    try { state.ws?.close() } catch {}
    state.ws = null
    state.status = "failed"
    return null
  }

  if (result.done) {
    // Stream ended immediately (error or empty)
    log.warn("ws stream ended before first frame", { sessionId })
    state.disableWebsockets = true
    return null
  }

  // Got first chunk — WS is working. Reconstruct stream with the first chunk prepended.
  const firstChunk = result.value as Uint8Array
  const remaining = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(firstChunk)
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          controller.enqueue(value)
        }
        controller.close()
      } catch (e) {
        controller.error(e)
      }
    },
  })

  return new Response(remaining, {
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

  // Account-aware lifecycle: when account changes, close the WS connection
  // (tokens differ) but preserve continuation state per-account so switching
  // back restores delta mode without a full-context re-send.
  if (state.accountId !== undefined && state.accountId !== accountId) {
    log.info("ws account changed, resetting to WS-first", {
      sessionId,
      old: state.accountId,
      new: accountId,
      wasDisabled: state.disableWebsockets,
    })
    // Save outgoing account's continuation state
    persistWsSession(sessionId + ":" + state.accountId, state)

    if (state.ws) {
      try { state.ws.close() } catch {}
    }
    state.ws = null
    state.status = "idle"
    state.disableWebsockets = false

    // Restore incoming account's continuation state (if previously saved)
    const restored = loadContinuation()[sessionId + ":" + accountId]
    state.lastResponseId = restored?.lastResponseId
    state.lastInputLength = restored?.lastInputLength
    if (restored?.lastResponseId) {
      log.info("ws continuation restored for returning account", {
        sessionId,
        accountId,
        responseId: restored.lastResponseId.slice(0, 16) + "...",
      })
    }
  }

  // Sticky fallback: once disabled, stay on HTTP until next account switch
  if (state.disableWebsockets) return null

  // Helper: attempt WS request with first-frame probe
  async function attemptWs(ws: WebSocket, reqBody: Record<string, unknown>): Promise<Response | null> {
    const rawResponse = wsRequest({ ws, body: reqBody, sessionId, state })
    return probeFirstFrame(rawResponse, sessionId, state)
  }

  // Reuse existing open connection
  if (state.ws && state.status === "open") {
    const reqBody = { ...body }
    if (state.lastResponseId && !reqBody.previous_response_id) {
      reqBody.previous_response_id = state.lastResponseId
    }

    try {
      const probed = await attemptWs(state.ws, reqBody)
      if (probed) return probed
      // First-frame timeout or continuation invalidated — check flag
      if (state.continuationInvalidated && state.ws && state.status === "open") {
        state.continuationInvalidated = false
        log.info("continuation invalidated, retrying on same WS without previous_response_id", { sessionId })
        const retryBody = { ...body }
        delete retryBody.previous_response_id
        const retried = await attemptWs(state.ws, retryBody)
        if (retried) return retried
      }
    } catch (e) {
      // Continuation invalidated during streaming — retry on same WS
      if (String(e).includes("CONTINUATION_INVALIDATED") && state.ws) {
        state.continuationInvalidated = false
        state.status = "open"
        log.info("continuation invalidated, retrying on same WS without previous_response_id", { sessionId })
        try {
          const retryBody = { ...body }
          delete retryBody.previous_response_id
          const retried = await attemptWs(state.ws, retryBody)
          if (retried) return retried
        } catch (retryErr) {
          log.warn("ws retry after invalidation also failed", { sessionId, error: String(retryErr).slice(0, 100) })
        }
      } else {
        log.warn("ws request failed on cached connection", { sessionId, error: String(e) })
      }
    }
    state.ws = null
    state.status = "failed"
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

      const reqBody = { ...body }
      if (state.lastResponseId && !reqBody.previous_response_id) {
        reqBody.previous_response_id = state.lastResponseId
      }

      try {
        const probed = await attemptWs(ws, reqBody)
        if (probed) return probed
        // Check invalidation flag — retry without previous_response_id
        if (state.continuationInvalidated && state.ws && state.status === "open") {
          state.continuationInvalidated = false
          log.info("continuation invalidated on new WS, retrying without previous_response_id", { sessionId })
          const retryBody = { ...body }
          delete retryBody.previous_response_id
          const retried = await attemptWs(state.ws, retryBody)
          if (retried) return retried
        }
      } catch (e) {
        if (String(e).includes("CONTINUATION_INVALIDATED") && ws) {
          state.continuationInvalidated = false
          state.status = "open"
          log.info("continuation invalidated on new WS, retrying without previous_response_id", { sessionId })
          try {
            const retryBody = { ...body }
            delete retryBody.previous_response_id
            const retried = await attemptWs(ws, retryBody)
            if (retried) return retried
          } catch (retryErr) {
            log.warn("ws retry after invalidation failed on new connection", { sessionId, error: String(retryErr).slice(0, 100) })
          }
        } else {
          log.warn("ws request failed on new connection", { sessionId, error: String(e) })
        }
      }
      state.ws = null
      state.status = "failed"
      continue
    }
  }

  // All attempts failed → activate sticky HTTP fallback
  log.warn("ws fallback to HTTP", { sessionId, retries: WS_MAX_CONNECT_RETRIES })
  state.disableWebsockets = true
  state.ws = null
  state.status = "failed"
  return null
}
