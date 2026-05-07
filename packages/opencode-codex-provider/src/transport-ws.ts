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

/**
 * WS-layer observation snapshot for the empty-turn classifier
 * (spec codex-empty-turn-recovery, INV-04). Mutated by the SSE
 * frame loop inside start(controller); read via getSnapshot()
 * by the SSE flush block in sse.ts when classifying empty turns.
 */
interface WsObservation {
  frameCount: number
  terminalEventReceived: boolean
  terminalEventType: "response.completed" | "response.incomplete" | "response.failed" | "error" | null
  wsCloseCode: number | null
  wsCloseReason: string | null
  serverErrorMessage: string | null
  /**
   * Verbatim WS-layer error reason captured when the empty turn
   * originated from ws.onerror, ws.onclose with frameCount=0, or
   * first_frame_timeout. Stays null otherwise. Drives DD-2 throw-leak
   * closure: previously these sites called endWithError(new Error(...))
   * which propagated up to processor.ts:isModelTemporaryError and
   * triggered unwarranted account rotation. With this field set, the
   * sites call endStream() instead and the SSE flush block routes
   * through the classifier (causeFamily ws_no_frames per DD-9).
   * Spec: fix-empty-response-rca DD-2 + DD-5.
   */
  wsErrorReason: string | null
  deltasObserved: { text: number; toolCallArguments: number; reasoning: number }
}

/**
 * Boundary contract between the WS transport and the SSE classifier
 * (spec codex-empty-turn-ws-snapshot-hotfix DD-1). The internal
 * WsObservation.frameCount is normalized to wsFrameCount on the
 * exported boundary so it matches the field name used by:
 *  - sse.ts MapResponseStreamOptions.getTransportSnapshot
 *  - empty-turn-classifier.ts EmptyTurnSnapshot
 *  - data-schema.json (empty-turns.jsonl wsFrameCount field)
 *
 * Returning the internal WsObservation directly produced bytes-on-disk
 * with the wrong field name (frameCount), which JSON.stringify dropped
 * as undefined when sse.ts read transportSnapshot.wsFrameCount, leading
 * to live JSONL rows missing wsFrameCount and falling through to
 * unclassified despite the WS layer having the evidence.
 */
export interface TransportSnapshot {
  wsFrameCount: number
  terminalEventReceived: boolean
  terminalEventType: "response.completed" | "response.incomplete" | "response.failed" | "error" | null
  wsCloseCode: number | null
  wsCloseReason: string | null
  serverErrorMessage: string | null
  /**
   * Verbatim WS-layer error reason for ws_no_frames discrimination
   * (fix-empty-response-rca DD-5). Populated when the empty turn
   * originated from ws.onerror / ws.onclose-frame=0 / first_frame_timeout.
   * Null when wsFrameCount > 0 (existing ws_truncation case where the
   * close itself is the signal) or when the empty turn originated
   * server-side. Surfaces in JSONL via the additive wsErrorReason field
   * per the data-schema.json extension.
   */
  wsErrorReason: string | null
  deltasObserved: { text: number; toolCallArguments: number; reasoning: number }
}

/**
 * Send-side stall watchdog (codex-update DD-3, mirrors codex commit 35aaa5d9fc).
 *
 * WHATWG WebSocket has no callback completion for `ws.send`; we approximate the
 * Rust `tokio::time::timeout(idle_timeout, ws_stream.send(...))` by polling
 * `ws.bufferedAmount` after the idle window. If `shouldFire()` returns true at
 * the deadline (typically: bytes still queued AND no frames received AND state
 * is still "streaming"), `onFire()` runs; otherwise the timer is a no-op.
 *
 * Exported for direct unit testing — `wsRequest` consumes it internally.
 */
export function armSendStallWatchdog(opts: {
  ws: Pick<WebSocket, "bufferedAmount">
  timeoutMs: number
  shouldFire: () => boolean
  onFire: () => void
}): ReturnType<typeof setTimeout> {
  return setTimeout(() => {
    if (opts.shouldFire()) {
      opts.onFire()
    }
  }, opts.timeoutMs)
}

export interface WsRequestResult {
  events: ReadableStream<ResponseStreamEvent>
  /** Snapshot getter for empty-turn classifier; returns a copy at call time */
  getSnapshot: () => TransportSnapshot
}

function wsRequest(input: {
  ws: WebSocket
  body: Record<string, unknown>
  sessionId: string
  state: WsSessionState
}): WsRequestResult {
  const { ws, body, sessionId, state } = input

  // Per-request observation, lifted out of the start(controller) closure
  // so the snapshot getter (used by SSE flush in sse.ts) can read these
  // values at the moment of empty-turn classification.
  const wsObs: WsObservation = {
    frameCount: 0,
    terminalEventReceived: false,
    terminalEventType: null,
    wsCloseCode: null,
    wsCloseReason: null,
    serverErrorMessage: null,
    wsErrorReason: null,
    deltasObserved: { text: 0, toolCallArguments: 0, reasoning: 0 },
  }

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
  const priorLastInputLength = state.lastInputLength
  state.lastInputLength = fullInputLength
  const deltaMode = !!wsBody.previous_response_id
  const trimmedInputLength = Array.isArray(wsBody.input) ? wsBody.input.length : 0
  // DIAG 2026-04-30: WS sync verification. Trace prevResp + length monotonicity
  // and the actual delta items being sent. Goal: catch (a) chain stale/forking,
  // (b) delta containing wrong slice, (c) compaction-after-shrink edge cases.
  const prevRespPrefix =
    typeof wsBody.previous_response_id === "string" ? (wsBody.previous_response_id as string).slice(0, 16) : "—"
  const tail = Array.isArray(wsBody.input)
    ? (wsBody.input as Array<{ role?: string; type?: string; content?: unknown }>)
        .slice(-3)
        .map((it) => {
          const role = (it as { role?: string }).role ?? (it as { type?: string }).type ?? "?"
          const c = (it as { content?: unknown }).content
          const preview =
            typeof c === "string"
              ? c.slice(0, 60)
              : Array.isArray(c)
                ? JSON.stringify(c).slice(0, 60)
                : c != null
                  ? JSON.stringify(c).slice(0, 60)
                  : ""
          return `${role}:${preview}`
        })
    : []
  console.error(
    `[CODEX-WS] REQ session=${sessionId} delta=${deltaMode} inputItems=${trimmedInputLength} fullItems=${fullInputLength} prevLen=${priorLastInputLength ?? "—"} prevResp=${prevRespPrefix} hasPrevResp=${!!wsBody.previous_response_id}${chainResetReason ? ` chainResetReason=${chainResetReason}` : ""} tail=${JSON.stringify(tail)}`,
  )

  const events = new ReadableStream<ResponseStreamEvent>({
    start(controller) {
      let idleTimer: ReturnType<typeof setTimeout> | null = null

      function resetIdleTimer() {
        if (idleTimer) clearTimeout(idleTimer)
        idleTimer = setTimeout(() => {
          const reason = wsObs.frameCount === 0 ? "first_frame_timeout" : "mid_stream_stall"
          doInvalidate(reason)
          if (wsObs.frameCount === 0) {
            // fix-empty-response-rca DD-2: do not throw upward. The empty
            // turn classifier (sse.ts flush block) will see wsFrameCount=0
            // and select ws_no_frames; wsErrorReason carries the reason
            // for the JSONL log entry. Previously this site called
            // controller.error which propagated up to processor.ts and
            // triggered isModelTemporaryError → unwarranted rotation.
            wsObs.wsErrorReason = reason
            state.status = "failed"
            endStream()
          } else {
            endStream()
          }
        }, WS_IDLE_TIMEOUT_MS)
      }

      // codex-update Phase 3 (DD-3): send-side idle watchdog. Upstream Rust
      // wraps `ws_stream.send(...)` in `tokio::time::timeout(idle_timeout, ...)`
      // (codex commit 35aaa5d9fc). WHATWG WebSocket has no callback completion,
      // so we approximate by polling `bufferedAmount` after the idle window;
      // if bytes are still queued and the stream hasn't ended, the OS write
      // pump is stalled and we abort with `ws_send_timeout` (INV-4: shared
      // WS_IDLE_TIMEOUT_MS for both directions; INV-5: classifier transient).
      let sendWatchdog: ReturnType<typeof setTimeout> | null = null

      const armSendWatchdog = () => {
        if (sendWatchdog) clearTimeout(sendWatchdog)
        sendWatchdog = armSendStallWatchdog({
          ws,
          timeoutMs: WS_IDLE_TIMEOUT_MS,
          shouldFire: () =>
            ws.bufferedAmount > 0 && wsObs.frameCount === 0 && state.status === "streaming",
          onFire: () => {
            const threadIdHint = (state.lastResponseId ?? "—").slice(0, 12)
            console.warn(
              `[CODEX-WS] WS send timeout session=${sessionId} thread=${threadIdHint} err=ws_send_timeout bufferedAmount=${ws.bufferedAmount}`,
            )
            wsObs.wsErrorReason = "ws_send_timeout"
            state.status = "failed"
            try {
              ws.close()
            } catch {}
            endStream()
          },
        })
      }

      function cleanup() {
        if (idleTimer) clearTimeout(idleTimer)
        if (sendWatchdog) clearTimeout(sendWatchdog)
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
        wsObs.frameCount++
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
            wsObs.terminalEventReceived = true
            wsObs.terminalEventType = "error"
            wsObs.serverErrorMessage = errorMsg.slice(0, 1024)
            endWithError(mapped || new Error(`Codex WS: ${errorMsg}`))
            return
          }

          // Forward event
          controller.enqueue(parsed as ResponseStreamEvent)

          // Track text-delta count at the WS layer (in addition to sse.ts's
          // own counter) so the snapshot getter is accurate even when the
          // SSE layer hasn't run flush yet (e.g., classifier called from
          // ws.onclose before flush). Keeps INV-10 invariant intact.
          if (parsed.type === "response.output_text.delta") wsObs.deltasObserved.text++
          else if (parsed.type === "response.function_call_arguments.delta")
            wsObs.deltasObserved.toolCallArguments++
          else if (parsed.type === "response.reasoning_summary_text.delta")
            wsObs.deltasObserved.reasoning++

          // Detect stream end
          if (parsed.type === "response.completed") {
            wsObs.terminalEventReceived = true
            wsObs.terminalEventType = "response.completed"
            const responseId = parsed.response?.id
            if (responseId) {
              const previousId = state.lastResponseId
              state.lastResponseId = responseId
              updateContinuation(sessionId, {
                lastResponseId: responseId,
                lastInputLength: state.lastInputLength,
                accountId: state.accountId,
              })
              // DIAG 2026-04-30: chain advancement. Verify monotonic move.
              console.error(
                `[CODEX-WS] CHAIN session=${sessionId} prev=${previousId ? previousId.slice(0, 16) : "—"} new=${responseId.slice(0, 16)} lastInputLength=${state.lastInputLength ?? "—"}`,
              )
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
            wsObs.terminalEventReceived = true
            wsObs.terminalEventType = "response.incomplete"
            const reason = (parsed.response as any)?.incomplete_details?.reason
            if (typeof reason === "string") wsObs.serverErrorMessage = reason.slice(0, 1024)
            doInvalidate("close_before_completion")
            endStream()
            return
          }

          if (parsed.type === "response.failed") {
            wsObs.terminalEventReceived = true
            wsObs.terminalEventType = "response.failed"
            const msg = parsed.response?.error?.message
            if (typeof msg === "string") wsObs.serverErrorMessage = msg.slice(0, 1024)
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
        if (wsObs.frameCount === 0) {
          // fix-empty-response-rca DD-2: previously endWithError("WebSocket error")
          // threw upward; processor.ts caught it via isModelTemporaryError and
          // triggered account rotation. Now: capture the reason for the JSONL
          // log entry (DD-5) and end the stream gracefully so the SSE flush
          // block routes through the classifier (ws_no_frames + retry).
          wsObs.wsErrorReason = "WebSocket error"
          endStream()
        } else {
          endStream()
        }
      }

      ws.onclose = (closeEvent: CloseEvent) => {
        // Capture WS-level close metadata for the empty-turn classifier
        // (spec codex-empty-turn-recovery: ws_truncation predicate uses
        // wsCloseCode/wsCloseReason to discriminate ws_no_frames vs
        // ws_truncation). Always recorded; SSE flush reads it via getSnapshot.
        if (closeEvent && typeof closeEvent.code === "number") {
          wsObs.wsCloseCode = closeEvent.code
        }
        if (closeEvent && typeof closeEvent.reason === "string") {
          wsObs.wsCloseReason = closeEvent.reason.slice(0, 256)
        }
        if (state.status === "streaming") {
          doInvalidate("close_before_completion")
          state.status = "failed"
          // Both branches now route through endStream() with classifier-decided
          // recovery; no exception propagates up to processor.ts. Predecessor
          // codex-empty-turn-recovery removed the "silent endStream() at line
          // 422" pattern from the frameCount > 0 case; fix-empty-response-rca
          // DD-2 finishes the job by also routing the frameCount === 0 case
          // through the classifier instead of throwing "WS closed before
          // response" — that throw was the L2 root cause of unwarranted
          // rotation thrash. wsErrorReason carries the diagnostic.
          if (wsObs.frameCount === 0) {
            wsObs.wsErrorReason = "WS closed before response"
          }
          endStream()
        }
      }

      // Send
      state.status = "streaming"
      resetIdleTimer()
      ws.send(JSON.stringify({ type: "response.create", ...wsBody }))
      armSendWatchdog()
    },
  })

  return {
    events,
    getSnapshot: () => ({
      wsFrameCount: wsObs.frameCount,
      terminalEventReceived: wsObs.terminalEventReceived,
      terminalEventType: wsObs.terminalEventType,
      wsCloseCode: wsObs.wsCloseCode,
      wsCloseReason: wsObs.wsCloseReason,
      serverErrorMessage: wsObs.serverErrorMessage,
      wsErrorReason: wsObs.wsErrorReason,
      deltasObserved: { ...wsObs.deltasObserved },
    }),
  }
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
  /** Thread ID for upstream codex session/thread split (`a98623511b`). Defaults to conversationId or sessionId when omitted. */
  threadId?: string
  /** @deprecated since codex-update plan — prefer `threadId`. Kept for back-compat; mapped into headers via the threadId fallback chain. */
  conversationId?: string
}

/**
 * Attempt WebSocket transport. Returns a {events, getSnapshot} pair,
 * or null if WS is unavailable (caller should fall back to HTTP).
 *
 * `getSnapshot()` returns a copy of the current WS-layer observation
 * (frameCount, terminalEventReceived, etc.) so the SSE flush block in
 * sse.ts can build an EmptyTurnSnapshot when classifying empty turns.
 */
export async function tryWsTransport(
  input: WsTransportInput,
): Promise<{ events: ReadableStream<ResponseStreamEvent>; getSnapshot: () => TransportSnapshot } | null> {
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
      const { events, getSnapshot } = wsRequest({ ws: state.ws, body: reqBody, sessionId, state })
      const probed = await probeFirstFrame(events, sessionId, state)
      if (probed) return { events: probed, getSnapshot }
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
    sessionId: input.sessionId,
    threadId: input.threadId ?? input.conversationId,
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
      const { events, getSnapshot } = wsRequest({ ws, body: reqBody, sessionId, state })
      const probed = await probeFirstFrame(events, sessionId, state)
      if (probed) return { events: probed, getSnapshot }
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
