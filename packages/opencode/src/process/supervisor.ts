import { Log } from "@/util/log"

export namespace ProcessSupervisor {
  const log = Log.create({ service: "process.supervisor" })

  export type Kind = "task-subagent" | "lsp" | "mcp" | "tool" | "other"
  export type Status = "running" | "stalled"

  type Entry = {
    id: string
    kind: Kind
    sessionID?: string
    parentSessionID?: string
    status: Status
    process?: Bun.Subprocess
    pid?: number
    startedAt: number
    lastActivityAt: number
  }

  const entries = new Map<string, Entry>()
  const sessionIndex = new Map<string, Set<string>>()

  function addToSession(id: string, sessionID?: string) {
    if (!sessionID) return
    let ids = sessionIndex.get(sessionID)
    if (!ids) {
      ids = new Set()
      sessionIndex.set(sessionID, ids)
    }
    ids.add(id)
  }

  function removeFromSession(id: string, sessionID?: string) {
    if (!sessionID) return
    const ids = sessionIndex.get(sessionID)
    if (!ids) return
    ids.delete(id)
    if (ids.size === 0) sessionIndex.delete(sessionID)
  }

  function removeEntry(id: string) {
    const existing = entries.get(id)
    if (!existing) return
    entries.delete(id)
    removeFromSession(id, existing.sessionID)
  }

  export function register(input: {
    id: string
    kind: Kind
    process?: Bun.Subprocess
    sessionID?: string
    parentSessionID?: string
  }) {
    const existing = entries.get(input.id)
    if (existing) {
      log.warn("Overwriting existing process entry", { id: input.id, kind: existing.kind })
      kill(input.id)
    }
    const now = Date.now()
    const next: Entry = {
      id: input.id,
      kind: input.kind,
      sessionID: input.sessionID,
      parentSessionID: input.parentSessionID,
      status: "running",
      process: input.process,
      pid: input.process?.pid,
      startedAt: now,
      lastActivityAt: now,
    }
    entries.set(input.id, next)
    addToSession(input.id, input.sessionID)
    if (input.process) {
      input.process.exited.finally(() => {
        const current = entries.get(input.id)
        if (!current) return
        if (current.process !== input.process) return
        removeEntry(input.id)
      })
    }
  }

  export function touch(id: string) {
    const entry = entries.get(id)
    if (!entry) return
    entry.lastActivityAt = Date.now()
    entry.status = "running"
  }

  export function markStalled(id: string) {
    const entry = entries.get(id)
    if (!entry) return
    entry.status = "stalled"
  }

  export function kill(id: string) {
    const entry = entries.get(id)
    if (!entry) return
    if (entry.process) {
      try {
        entry.process.kill()
      } catch (error) {
        log.error("Failed to kill process", { id, error })
      }
    }
    removeEntry(id)
  }

  export async function disposeAll() {
    for (const id of entries.keys()) {
      kill(id)
    }
  }

  export function sessionState(sessionID: string): Status | undefined {
    const ids = sessionIndex.get(sessionID)
    if (!ids || ids.size === 0) return
    let hasStalled = false
    for (const id of ids) {
      const entry = entries.get(id)
      if (!entry) continue
      if (entry.status === "running") return "running"
      hasStalled = true
    }
    return hasStalled ? "stalled" : undefined
  }

  export function isSessionActive(sessionID: string) {
    return sessionState(sessionID) === "running"
  }

  export function snapshot() {
    return Array.from(entries.values()).map((entry) => ({ ...entry }))
  }
}

