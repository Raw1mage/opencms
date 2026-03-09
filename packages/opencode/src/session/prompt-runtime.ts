import { Instance } from "../project/instance"
import { MessageV2 } from "./message-v2"
import { Session } from "."
import { SessionStatus } from "./status"

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

const state = Instance.state(
  () => {
    const data: Record<string, RuntimeEntry> = {}
    return data
  },
  async (current) => {
    for (const item of Object.values(current)) {
      item.abort.abort()
    }
  },
)

export function assertNotBusy(sessionID: string) {
  const match = state()[sessionID]
  if (match) throw new Session.BusyError(sessionID)
}

export function start(sessionID: string, options?: { replace?: boolean }): RuntimeStart | undefined {
  const s = state()
  const current = s[sessionID]
  if (current && !options?.replace) return
  if (current && options?.replace) current.abort.abort()
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

export function cancel(sessionID: string) {
  const s = state()
  const match = s[sessionID]
  if (!match) {
    SessionStatus.set(sessionID, { type: "idle" })
    return
  }
  match.abort.abort()
}

export function finish(sessionID: string, runID: string) {
  const s = state()
  const match = s[sessionID]
  if (!match || match.runID !== runID) return
  delete s[sessionID]
  SessionStatus.set(sessionID, { type: "idle" })
}
