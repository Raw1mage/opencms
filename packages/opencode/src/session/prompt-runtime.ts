import { Instance } from "../project/instance"
import { MessageV2 } from "./message-v2"
import { Session } from "."
import { SessionStatus } from "./status"
import { Log } from "../util/log"

const log = Log.create({ service: "session.prompt-runtime" })

/**
 * Canonical reasons for aborting a running session prompt. Every caller of
 * `cancel` must supply a value from this union; TypeScript enforces the
 * closed set so log grep (`grep '"reason":"rate-limit-fallback"'`) stays
 * reliable across the codebase.
 */
export type CancelReason =
  | "manual-stop"
  | "rate-limit-fallback"
  | "monitor-watchdog"
  | "instance-dispose"
  | "replace"
  | "session-switch"
  | "killswitch"
  | "parent-abort"
  | "runaway-guard"
  | "unknown"

type RuntimeEntry = {
  runID: string
  abort: AbortController
  callbacks: {
    resolve(input: MessageV2.WithParts): void
    reject(reason?: any): void
  }[]
  // Promise resolvers queued by waitForSlot(). Drained on finish() so
  // callers blocked waiting for the slot to open can re-attempt start().
  // Unlike `callbacks`, these DO NOT receive the finishing runloop's
  // result — they represent "a new prompt arrived while this runtime was
  // mid-cleanup; it needs its OWN runloop against its OWN user message".
  slotWaiters: Array<() => void>
}

export type RuntimeStart = {
  runID: string
  signal: AbortSignal
}

function createState() {
  const data: Record<string, RuntimeEntry> = {}
  return data
}

async function cleanupState(current: ReturnType<typeof createState>) {
  for (const item of Object.values(current)) {
    item.abort.abort("instance-dispose" satisfies CancelReason)
  }
}

function callerFrame(): string | undefined {
  // Drop first 3 frames: Error header, callerFrame itself, direct caller (cancel).
  // The useful frame is the site that invoked cancel.
  const stack = new Error().stack
  if (!stack) return undefined
  const lines = stack.split("\n")
  return lines[3]?.trim()
}

let stateGetter: (() => ReturnType<typeof createState>) | undefined
let fallbackState: ReturnType<typeof createState> | undefined

function state() {
  if (typeof Instance.state === "function") {
    stateGetter ||= Instance.state(createState, cleanupState)
    return stateGetter()
  }

  fallbackState ||= createState()
  return fallbackState
}

export function assertNotBusy(sessionID: string) {
  const match = state()[sessionID]
  if (match) throw new Session.BusyError(sessionID)
}

/**
 * Whether a runloop is currently registered for this session. Used by
 * shouldInterruptForIncomingPrompt and the subagent-busy-indicator
 * subscriber to distinguish "runtime running" from "no runtime, but a
 * subagent is attached" — both states report status=busy externally.
 */
export function isRuntimeRegistered(sessionID: string): boolean {
  return !!state()[sessionID]
}

/**
 * Cross-module hook so the runtime can ask "does this session have an
 * active subagent right now?" without importing tool/task.ts directly
 * (which would create a session ↔ tool/task module cycle).
 *
 * Registered once at process init from the layer that owns
 * `SessionActiveChild` state. Defaults to "no child", so behavior
 * pre-registration is the original idle-on-finish path.
 */
let activeChildChecker: (sessionID: string) => boolean = () => false
export function registerActiveChildChecker(fn: typeof activeChildChecker) {
  activeChildChecker = fn
}

export function start(sessionID: string, options?: { replace?: boolean }): RuntimeStart | undefined {
  const s = state()
  const current = s[sessionID]
  if (current && !options?.replace) return
  if (current && options?.replace) current.abort.abort("replace" satisfies CancelReason)
  const controller = new AbortController()
  const runID = `${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`
  // Carry-over: preserve slotWaiters across a replace so waiters don't get
  // stranded when two back-to-back prompts collide with interrupt handling.
  // Callbacks carry-over stays as before (historical behaviour).
  const carriedSlotWaiters = current && options?.replace ? current.slotWaiters : []
  s[sessionID] = {
    runID,
    abort: controller,
    callbacks: current && options?.replace ? current.callbacks : [],
    slotWaiters: carriedSlotWaiters,
  }
  log.info("start", {
    sessionID,
    runID,
    replace: !!options?.replace,
    carriedWaiters: carriedSlotWaiters.length,
  })
  return {
    runID,
    signal: controller.signal,
  }
}

/**
 * Wait until the current runtime slot for this session is released (by
 * finish() or cancel()). Used by runLoop() entry when a new prompt arrives
 * while an older runloop is still in its post-reply cleanup window —
 * the new prompt must get its own runloop against its own user message
 * instead of being resolved with the old runloop's stale reply.
 *
 * Safe to call when no runtime exists — resolves immediately.
 */
export function waitForSlot(sessionID: string): Promise<void> {
  const s = state()
  const current = s[sessionID]
  if (!current) return Promise.resolve()
  const enqueuedAt = Date.now()
  log.info("waitForSlot enqueue", {
    sessionID,
    activeRunID: current.runID,
    waitersAhead: current.slotWaiters.length,
  })
  return new Promise<void>((resolve) => {
    current.slotWaiters.push(() => {
      log.info("waitForSlot release", {
        sessionID,
        waitedMs: Date.now() - enqueuedAt,
      })
      resolve()
    })
  })
}

export function enqueueCallback(
  sessionID: string,
  callback: {
    resolve(input: MessageV2.WithParts): void
    reject(reason?: any): void
  },
) {
  const s = state()
  if (!s[sessionID]) {
    throw new Error(`No runtime session for ${sessionID}`)
  }
  s[sessionID].callbacks.push(callback)
}

export function consumeCallbacks(sessionID: string) {
  const s = state()
  return s[sessionID]?.callbacks ?? []
}

export function cancel(sessionID: string, reason: CancelReason) {
  const s = state()
  const match = s[sessionID]
  const caller = callerFrame()
  log.info("cancel", { sessionID, reason, caller })
  if (!match) {
    SessionStatus.set(sessionID, { type: "idle" })
    return
  }
  match.abort.abort(reason)
}

export function finish(sessionID: string, runID: string) {
  const s = state()
  const match = s[sessionID]
  if (!match) {
    // Runtime entry already gone (e.g. cleaned up externally).
    // Ensure status is not left stuck on "busy".
    if (SessionStatus.get(sessionID).type !== "idle") {
      log.warn("finish: runtime entry missing but status not idle — forcing idle", { sessionID, runID })
      SessionStatus.set(sessionID, { type: "idle" })
    }
    return
  }
  if (match.runID !== runID) {
    // A newer runtime has taken over — don't touch it.
    log.info("finish: runID mismatch, newer runtime active — skipping", { sessionID, runID, activeRunID: match.runID })
    return
  }
  const waiters = match.slotWaiters
  delete s[sessionID]
  // If a subagent is still running on behalf of this session, keep the
  // outward status as busy so the UI continues to render the clock and
  // stop button. The subagent-busy-indicator subscriber will flip back
  // to idle when SessionActiveChild clears (and no new runtime has
  // taken over by then). Restores pre-Phase-9 visible-busy + interactive
  // coexistence (responsive-orchestrator c32ba0dac dropped the visible
  // signal but kept the interactivity).
  if (activeChildChecker(sessionID)) {
    log.info("finish: keeping status=busy (subagent still running)", { sessionID, runID })
  } else {
    SessionStatus.set(sessionID, { type: "idle" })
  }
  log.info("finish", { sessionID, runID, releasedWaiters: waiters.length })
  // Release waiters AFTER the entry is deleted so their follow-up start()
  // call sees a clean slot.
  for (const w of waiters) {
    try {
      w()
    } catch {
      // swallow — waiter error must not stop release of others
    }
  }
}
