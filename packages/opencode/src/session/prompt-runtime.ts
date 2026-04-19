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
  | "unknown"

type RuntimeEntry = {
  runID: string
  abort: AbortController
  callbacks: {
    resolve(input: MessageV2.WithParts): void
    reject(reason?: any): void
  }[]
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

export function start(sessionID: string, options?: { replace?: boolean }): RuntimeStart | undefined {
  const s = state()
  const current = s[sessionID]
  if (current && !options?.replace) return
  if (current && options?.replace) current.abort.abort("replace" satisfies CancelReason)
  const controller = new AbortController()
  const runID = `${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`
  s[sessionID] = {
    runID,
    abort: controller,
    callbacks: current && options?.replace ? current.callbacks : [],
  }
  return {
    runID,
    signal: controller.signal,
  }
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
  delete s[sessionID]
  SessionStatus.set(sessionID, { type: "idle" })
}
