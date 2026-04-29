/**
 * Codex WebSocket transport.
 *
 * Manages WS connection lifecycle, incremental delta, first-frame probe,
 * and continuation state. Produces a ReadableStream<ResponseStreamEvent>
 * that the provider consumes directly (no synthetic SSE bridge).
 *
 * Extracted from plugin/codex-websocket.ts.
 */
import { WS_CONNECT_TIMEOUT_MS, WS_IDLE_TIMEOUT_MS, WS_FIRST_FRAME_TIMEOUT_MS } from "./protocol.js"
import {
  getContinuation,
  updateContinuation,
  invalidateContinuation,
  invalidateContinuationFamily,
} from "./continuation.js"
import { buildHeaders } from "./headers.js"
import type { ResponseStreamEvent } from "./types.js"

// ---------------------------------------------------------------------------
// § 1  Session state (in-memory)
// ---------------------------------------------------------------------------

interface WsSessionState {
  ws: WebSocket | null
  status: "idle" | "connecting" | "open" | "streaming" | "failed"
  accountId?: string
  lastResponseId?: string
  lastInputLength?: number
  disableWebsockets: boolean
  continuationInvalidated?: boolean
  // True once a `response.completed` event has landed for this session
  // within the current daemon process. Starts false even when state is
  // hydrated from disk — persisted continuations survive daemon restart
  // but Codex's server-side state might not, so the first request of a
  // fresh process must not trust the carry-over blindly. After one
  // successful completion we know the continuation is live on both sides
  // and subsequent requests can reuse it normally.
  validatedInProcess?: boolean
  // True when the persisted `lastResponseId` was loaded from disk (i.e.
  // produced by a previous daemon life), as opposed to written by this
  // process. Used to distinguish "stale carry-over" from "freshly
  // earned". Cleared once validatedInProcess becomes true.
  continuationFromDisk?: boolean
}

const sessions = new Map<string, WsSessionState>()

function getSession(sessionId: string): WsSessionState {
  let state = sessions.get(sessionId)
  if (!state) {
    const persisted = getContinuation(sessionId)
    const hasPersisted = !!persisted.lastResponseId
    state = {
      ws: null,
      status: "idle",
      disableWebsockets: false,
      lastResponseId: persisted.lastResponseId,
      lastInputLength: persisted.lastInputLength,
      accountId: persisted.accountId,
      validatedInProcess: false,
      continuationFromDisk: hasPersisted,
    }
    sessions.set(sessionId, state)
  }
  return state
}

/** Reset WS session after compaction — invalidate continuation + advance window */
export function resetWsSession(sessionId: string) {
  const state = sessions.get(sessionId)
  if (state) {
    if (state.ws) {
      try {
        state.ws.close()
      } catch {}
      state.ws = null
    }
    state.status = "idle"
    state.lastResponseId = undefined
    state.lastInputLength = undefined
    invalidateContinuationFamily(sessionId)
  }
}

export function closeWsSession(sessionId: string) {
  const state = sessions.get(sessionId)
  if (state?.ws) {
    try {
      state.ws.close()
    } catch {}
    state.ws = null
    state.status = "idle"
  }
}

// ---------------------------------------------------------------------------
// § 2  Error parsing (codex-rs responses_websocket.rs)
// ---------------------------------------------------------------------------

interface WrappedError {
  type?: string
  code?: string
  message?: string
  plan_type?: string
  resets_at?: number
}

interface WrappedErrorEvent {
  type: string
  status?: number
  error?: WrappedError
}

function parseErrorEvent(data: string): WrappedErrorEvent | null {
  try {
    const event = JSON.parse(data)
    return event.type === "error" ? event : null
  } catch {
    return null
  }
}

function mapError(event: WrappedErrorEvent): Error | null {
  const code = event.error?.code
  const message = event.error?.message || event.error?.type || "Unknown Codex WS error"
  if (code === "websocket_connection_limit_reached") {
    return new Error("Codex WS: connection limit reached. Reconnecting...")
  }
  if (event.status) {
    const plan = event.error?.plan_type ? ` (plan: ${event.error.plan_type})` : ""
    return new Error(`Codex API error (${event.status}): ${message}${plan}`)
  }
  return null
}

// ---------------------------------------------------------------------------
// § 3  WS connection
// ---------------------------------------------------------------------------

function connectWs(url: string, headers: Record<string, string>): Promise<WebSocket | null> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      try {
        ws.close()
      } catch {}
      resolve(null)
    }, WS_CONNECT_TIMEOUT_MS)

    let ws: WebSocket
    try {
      ws = new WebSocket(url, { headers } as any)
    } catch {
      clearTimeout(timeout)
      resolve(null)
      return
    }

    ws.onopen = () => {
      clearTimeout(timeout)
      resolve(ws)
    }
    ws.onerror = () => {
      clearTimeout(timeout)
      resolve(null)
    }
    ws.onclose = () => {
      clearTimeout(timeout)
      resolve(null)
    }
  })
}

// ---------------------------------------------------------------------------
// § 4  WS request → ResponseStreamEvent stream
// ---------------------------------------------------------------------------

function wsRequest(input: {
  ws: WebSocket
  body: Record<string, unknown>
  sessionId: string
  state: WsSessionState
}): ReadableStream<ResponseStreamEvent> {
  const { ws, body, sessionId, state } = input

  // Strip transport-specific fields
  const { stream: _s, background: _b, ...wsBody } = body

  // Incremental delta: trim input if previous_response_id is set.
  //
  // Strict mode: only honour the chain when the new input array has
  // STRICTLY GROWN past lastInputLength. If length is equal or shorter
  // (length-preserving content edits, retry-from-anchor, post-compaction
  // shrink with stale lastInputLength, tool-output rechunking), the chain
  // pointer cannot be trusted — sending the full array atop a stale
  // previous_response_id makes the server append the entire array to its
  // hidden state, which is the silent root of "Codex WS: exceeds context
  // window" hits at low local context.
  const fullInputLength = Array.isArray(wsBody.input) ? wsBody.input.length : 0
  let chainResetReason: string | null = null
  if (wsBody.previous_response_id && Array.isArray(wsBody.input)) {
    const lastLen = state.lastInputLength ?? 0
    if (lastLen > 0 && wsBody.input.length > lastLen) {
      wsBody.input = wsBody.input.slice(lastLen)
    } else {
      // Length did not strictly grow — chain is unreliable. Drop chain
      // pointer and send full input stateless.
      chainResetReason = `length_not_grown(prev=${lastLen},now=${wsBody.input.length})`
      delete wsBody.previous_response_id
      state.lastResponseId = undefined
      state.lastInputLength = undefined
      invalidateContinuationFamily(sessionId)
    }
  }
  state.lastInputLength = fullInputLength
  const deltaMode = !!wsBody.previous_response_id
  const trimmedInputLength = Array.isArray(wsBody.input) ? wsBody.input.length : 0
  console.error(
    `[CODEX-WS] REQ session=${sessionId} delta=${deltaMode} inputItems=${trimmedInputLength} fullItems=${fullInputLength} hasPrevResp=${!!wsBody.previous_response_id}${chainResetReason ? ` chainResetReason=${chainResetReason}` : ""}`,
  )

  return new ReadableStream<ResponseStreamEvent>({
    start(controller) {
      let frameCount = 0
      let idleTimer: ReturnType<typeof setTimeout> | null = null

      function resetIdleTimer() {
        if (idleTimer) clearTimeout(idleTimer)
        idleTimer = setTimeout(() => {
          const reason = frameCount === 0 ? "first_frame_timeout" : "mid_stream_stall"
          doInvalidate(reason)
          if (frameCount === 0) {
            controller.error(new Error(`Codex WS: ${reason}`))
            state.status = "failed"
            cleanup()
          } else {
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
          controller.close()
        } catch {}
        state.status = "open"
      }

      function endWithError(err: Error) {
        cleanup()
        state.status = "failed"
        try {
          controller.error(err)
        } catch {}
      }

      function doInvalidate(_reason: string) {
        state.lastResponseId = undefined
        state.lastInputLength = undefined
        invalidateContinuationFamily(sessionId)
      }

      ws.onmessage = (event: MessageEvent) => {
        const data = typeof event.data === "string" ? event.data : ""
        if (!data) return
        frameCount++
        resetIdleTimer()

        try {
          const parsed = JSON.parse(data)
          // Rate limits frame — keep-alive, don't forward
          if (parsed.type === "codex.rate_limits") {
            // CONTEXT-CEILING PROBE: don't silently drop. Log full payload
            // — codex may carry plan / quota / context-window hints here.
            try {
              console.error(
                `[CODEX-WS] RATE_LIMITS session=${sessionId} payload=${JSON.stringify(parsed).slice(0, 800)}`,
              )
            } catch {}
            return
          }

          // Error-first parsing
          const errorEvent = parseErrorEvent(data)
          if (errorEvent) {
            const mapped = mapError(errorEvent)
            const errorMsg = mapped?.message || errorEvent.error?.message || "Unknown WS error"
            const errorCode = errorEvent.error?.code || ""
            const isPrevRespNotFound =
              errorCode.includes("previous_response") ||
              errorMsg.includes("Previous response") ||
              errorMsg.includes("not found")

            if (isPrevRespNotFound) {
              doInvalidate("previous_response_not_found")
              state.continuationInvalidated = true
              cleanup()
              state.status = "failed"
              try {
                controller.error(new Error("CONTINUATION_INVALIDATED"))
              } catch {}
              return
            }

            // CONTEXT-CEILING PROBE: when server says context_length_exceeded,
            // dump full error body. Upstream typically embeds a "max=N tokens,
            // provided=M" hint that gives us an upper bound on the real
            // server-side context limit. Pair this with USAGE logs (success
            // max = lower bound) to detect silent window shrinkage.
            const isContextOverflow =
              errorCode === "context_length_exceeded" || /exceeds the context window/i.test(errorMsg)
            if (isContextOverflow) {
              state.continuationInvalidated = true
              try {
                console.error(
                  `[CODEX-WS] OVERFLOW session=${sessionId} model=${(wsBody as any).model ?? "?"} lastInputLength=${state.lastInputLength ?? 0} fullInputLength=${fullInputLength} hasPrevResp=${!!wsBody.previous_response_id} errorCode=${errorCode} errorMsg=${JSON.stringify(errorMsg).slice(0, 400)} fullEvent=${JSON.stringify(errorEvent).slice(0, 800)}`,
                )
              } catch {}
            }

            doInvalidate("ws_error")
            endWithError(mapped || new Error(`Codex WS: ${errorMsg}`))
            return
          }

          // Forward event
          controller.enqueue(parsed as ResponseStreamEvent)

          // Detect stream end
          if (parsed.type === "response.completed") {
            const responseId = parsed.response?.id
            if (responseId) {
              state.lastResponseId = responseId
              updateContinuation(sessionId, {
                lastResponseId: responseId,
                lastInputLength: state.lastInputLength,
                accountId: state.accountId,
              })
            }
            // CONTEXT-CEILING PROBE: log server-reported usage. The highest
            // input_tokens we ever see on a successful turn is the lower
            // bound on the server's real context window. If this number
            // suddenly drops, the server has silently shrunk the limit.
            try {
              const usage = parsed.response?.usage
              if (usage) {
                console.error(
                  `[CODEX-WS] USAGE session=${sessionId} model=${(wsBody as any).model ?? "?"} input_tokens=${usage.input_tokens ?? "?"} output_tokens=${usage.output_tokens ?? "?"} total_tokens=${usage.total_tokens ?? "?"} reasoning_tokens=${usage.output_tokens_details?.reasoning_tokens ?? "?"} cached_tokens=${usage.input_tokens_details?.cached_tokens ?? "?"} hasPrevResp=${!!wsBody.previous_response_id}`,
                )
              }
            } catch {}
            // Mark this process's view of the session as validated — a
            // full round-trip completed successfully. Subsequent requests
            // can now trust lastResponseId as continuation input.
            state.validatedInProcess = true
            state.continuationFromDisk = false
            endStream()
            return
          }

          if (parsed.type === "response.incomplete") {
            doInvalidate("close_before_completion")
            endStream()
            return
          }

          if (parsed.type === "response.failed") {
            doInvalidate("response_failed")
            endWithError(new Error(`Codex: ${parsed.response?.error?.message || "Response failed"}`))
            return
          }
        } catch {
          // JSON parse error — skip frame
        }
      }

      ws.onerror = () => {
        doInvalidate("ws_error")
        frameCount === 0 ? endWithError(new Error("WebSocket error")) : endStream()
      }

      ws.onclose = () => {
        if (state.status === "streaming") {
          doInvalidate("close_before_completion")
          state.status = "failed"
          frameCount === 0 ? endWithError(new Error("WS closed before response")) : endStream()
        }
      }

      // Send
      state.status = "streaming"
      resetIdleTimer()
      ws.send(JSON.stringify({ type: "response.create", ...wsBody }))
    },
  })
}

// ---------------------------------------------------------------------------
// § 5  First-frame probe
// ---------------------------------------------------------------------------

async function probeFirstFrame(
  events: ReadableStream<ResponseStreamEvent>,
  sessionId: string,
  state: WsSessionState,
): Promise<ReadableStream<ResponseStreamEvent> | null> {
  const reader = events.getReader()

  const result = (await Promise.race([
    reader.read(),
    new Promise<{ timeout: true }>((resolve) =>
      setTimeout(() => resolve({ timeout: true }), WS_FIRST_FRAME_TIMEOUT_MS),
    ),
  ])) as any

  if (result.timeout) {
    reader.cancel()
    state.lastResponseId = undefined
    state.lastInputLength = undefined
    invalidateContinuation(sessionId)
    state.disableWebsockets = true
    try {
      state.ws?.close()
    } catch {}
    state.ws = null
    state.status = "failed"
    return null
  }

  if (result.done) {
    state.disableWebsockets = true
    return null
  }

  // Got first event — reconstruct stream with it prepended
  const firstEvent = result.value as ResponseStreamEvent
  return new ReadableStream<ResponseStreamEvent>({
    async start(controller) {
      controller.enqueue(firstEvent)
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
}

// ---------------------------------------------------------------------------
// § 6  Public API: tryWsTransport
// ---------------------------------------------------------------------------

export interface WsTransportInput {
  sessionId: string
  accessToken: string
  accountId?: string
  turnState?: string
  body: Record<string, unknown>
  wsUrl: string
  userAgent?: string
  conversationId?: string
}

/**
 * Attempt WebSocket transport. Returns a ResponseStreamEvent stream,
 * or null if WS is unavailable (caller should fall back to HTTP).
 */
export async function tryWsTransport(input: WsTransportInput): Promise<ReadableStream<ResponseStreamEvent> | null> {
  const { sessionId, accessToken, accountId, body, wsUrl } = input
  const state = getSession(sessionId)

  // Daemon-restart safety: if this session's continuation came from disk
  // (previous daemon life) and we have not yet completed a response in
  // this process, drop the carry-over before the first request. Codex's
  // server-side state for that lastResponseId may or may not still be
  // valid — getting a generic "An error occurred while processing your
  // request" from the upstream after a restart is the empirical symptom
  // users hit. Trading one round's continuation-cache benefit for
  // reliability is worth it; after the first successful completion the
  // carry-over flag clears and subsequent calls reuse continuation
  // normally.
  if (state.continuationFromDisk && !state.validatedInProcess && state.lastResponseId) {
    console.error(
      `[CODEX-WS] dropping disk-persisted continuation before first call session=${sessionId} lastResponseId=${state.lastResponseId.slice(0, 12)}...`,
    )
    state.lastResponseId = undefined
    state.lastInputLength = undefined
    invalidateContinuationFamily(sessionId)
    state.continuationFromDisk = false
  }

  // Account switch: close WS, preserve per-account continuation
  if (state.accountId !== undefined && state.accountId !== accountId) {
    updateContinuation(`${sessionId}:${state.accountId}`, {
      lastResponseId: state.lastResponseId,
      lastInputLength: state.lastInputLength,
      accountId: state.accountId,
    })

    if (state.ws)
      try {
        state.ws.close()
      } catch {}
    state.ws = null
    state.status = "idle"
    state.disableWebsockets = false

    const restored = getContinuation(`${sessionId}:${accountId}`)
    state.lastResponseId = restored.lastResponseId
    state.lastInputLength = restored.lastInputLength
  }

  if (state.disableWebsockets) return null

  // Reuse existing connection
  if (state.ws && state.status === "open" && state.ws.readyState === WebSocket.OPEN) {
    const reqBody = { ...body }
    if (state.lastResponseId && !reqBody.previous_response_id) {
      reqBody.previous_response_id = state.lastResponseId
    }

    try {
      const events = wsRequest({ ws: state.ws, body: reqBody, sessionId, state })
      const probed = await probeFirstFrame(events, sessionId, state)
      if (probed) return probed
    } catch {}

    state.ws = null
    state.status = "failed"
    state.continuationInvalidated = false
  } else if (state.ws) {
    state.ws = null
    state.status = "failed"
    state.lastResponseId = undefined
    state.lastInputLength = undefined
    invalidateContinuation(sessionId)
  }

  const headers = buildHeaders({
    accessToken,
    accountId,
    turnState: input.turnState,
    userAgent: input.userAgent,
    conversationId: input.conversationId,
    isWebSocket: true,
  })

  const ws = await connectWs(wsUrl, headers)
  if (ws) {
    state.ws = ws
    state.status = "open"
    state.accountId = accountId

    const reqBody = { ...body }

    // Fresh WS connection: no continuation state, start clean.
    delete reqBody.previous_response_id
    state.lastResponseId = undefined
    state.lastInputLength = undefined
    invalidateContinuation(sessionId)

    try {
      const events = wsRequest({ ws, body: reqBody, sessionId, state })
      const probed = await probeFirstFrame(events, sessionId, state)
      if (probed) return probed
    } catch {}

    state.ws = null
    state.status = "failed"
  }

  // All failed → sticky HTTP fallback
  state.disableWebsockets = true
  state.ws = null
  state.status = "failed"
  return null
}
