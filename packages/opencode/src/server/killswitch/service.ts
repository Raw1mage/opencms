import { Bus } from "@/bus"
import { Identifier } from "@/id/id"
import { Event } from "@/server/event"
import { Session } from "@/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionStatus } from "@/session/status"
import { Storage } from "@/storage/storage"
import { Log } from "@/util/log"
import z from "zod"

const log = Log.create({ service: "killswitch" })

export namespace KillSwitchService {

  export const State = z.object({
    active: z.boolean(),
    state: z.enum(["soft_paused", "inactive"]),
    requestID: z.string(),
    initiator: z.string(),
    reason: z.string(),
    initiatedAt: z.number(),
    mode: z.string(),
    scope: z.string(),
    workspaceId: z.string().optional(),
    ttl: z.number().nullable().optional(),
    snapshotURL: z.string().nullable().optional(),
  })

  export const Ack = z.object({
    requestID: z.string(),
    sessionID: z.string(),
    seq: z.number(),
    status: z.enum(["accepted", "rejected", "error"]),
    reason: z.string().optional(),
    timestamp: z.number(),
  })

  export const ControlAction = z.enum(["pause", "resume", "cancel", "snapshot", "set_priority"])

  type ControlAction = z.infer<typeof ControlAction>

  type PublishControlInput = {
    requestID: string
    sessionID: string
    seq: number
    action: ControlAction
    initiator: string
    timeoutMs?: number
  }

  type SnapshotInput = {
    requestID: string
    initiator: string
    mode: string
    scope: string
    reason: string
  }

  type ControlTransport = {
    publishAndAwaitAck(input: PublishControlInput): Promise<z.infer<typeof Ack>>
  }

  type SnapshotBackend = {
    create(input: SnapshotInput): Promise<string | null>
  }

  export async function writeAudit(input: {
    requestID?: string
    sessionID?: string
    initiator?: string
    action: string
    permission?: string
    result?: string
    reason?: string
    meta?: Record<string, unknown>
  }) {
    const id = `ks_audit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const payload = {
      id,
      requestID: input.requestID,
      sessionID: input.sessionID,
      initiator: input.initiator ?? "unknown",
      action: input.action,
      permission: input.permission,
      result: input.result,
      reason: input.reason,
      meta: input.meta ?? {},
      timestamp: Date.now(),
    }
    await Storage.write(["killswitch", "audit", id], payload)
    return payload
  }

  export async function checkCooldown(initiator: string, windowMs = 5000) {
    const key = ["killswitch", "cooldown", initiator]
    const prev = await Storage.read<{ at: number }>(key).catch(() => undefined)
    const now = Date.now()
    if (prev && now - prev.at < windowMs) {
      return { ok: false, remainingMs: windowMs - (now - prev.at) }
    }
    await Storage.write(key, { at: now })
    return { ok: true, remainingMs: 0 }
  }

  export async function idempotentRequestID(initiator: string, reason: string, windowMs = 10_000) {
    const key = ["killswitch", "idempotency", `${initiator}::${reason}`]
    const prev = await Storage.read<{ requestID: string; at: number }>(key).catch(() => undefined)
    const now = Date.now()
    if (prev && now - prev.at < windowMs) return prev.requestID
    const requestID = `ks_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    await Storage.write(key, { requestID, at: now })
    return requestID
  }

  export async function generateMfa(requestID: string, initiator: string, ttlMs = 5 * 60 * 1000) {
    const code = Math.floor(100000 + Math.random() * 900000).toString()
    await Storage.write(["killswitch", "mfa", requestID], {
      requestID,
      initiator,
      code,
      expiresAt: Date.now() + ttlMs,
    })
    return code
  }

  export async function verifyMfa(requestID: string, initiator: string, code: string) {
    const token = await Storage.read<{ initiator: string; code: string; expiresAt: number }>([
      "killswitch",
      "mfa",
      requestID,
    ]).catch(() => undefined)
    if (!token) return false
    if (token.initiator !== initiator) return false
    if (Date.now() > token.expiresAt) return false
    if (token.code !== code) return false
    await Storage.remove(["killswitch", "mfa", requestID]).catch(() => undefined)
    return true
  }

  export async function getState() {
    const state = await Storage.read<z.infer<typeof State>>(["killswitch", "state", "current"]).catch(() => undefined)
    if (!state) return undefined
    return State.parse(state)
  }

  export async function setState(state: z.infer<typeof State>) {
    await Storage.write(["killswitch", "state", "current"], state)
    Bus.publish(Event.KillSwitchChanged, {
      active: state.active,
      state: state.state,
      requestID: state.requestID,
      initiator: state.initiator,
      reason: state.reason,
      snapshotURL: state.snapshotURL ?? null,
    })
  }

  export async function clearState() {
    await Storage.remove(["killswitch", "state", "current"]).catch(() => undefined)
    Bus.publish(Event.KillSwitchChanged, {
      active: false,
      state: "inactive",
    })
  }

  async function getLastSeq(sessionID: string) {
    const v = await Storage.read<{ value: number }>(["killswitch", "seq", sessionID]).catch(() => undefined)
    return v?.value ?? 0
  }

  async function setLastSeq(sessionID: string, seq: number) {
    await Storage.write(["killswitch", "seq", sessionID], { value: seq })
  }

  export async function handleControl(input: {
    requestID: string
    sessionID: string
    seq: number
    action: ControlAction
    initiator: string
  }) {
    const last = await getLastSeq(input.sessionID)
    if (input.seq <= last) {
      const ack = {
        requestID: input.requestID,
        sessionID: input.sessionID,
        seq: input.seq,
        status: "rejected" as const,
        reason: "seq_not_higher",
        timestamp: Date.now(),
      }
      await writeAudit({
        requestID: input.requestID,
        sessionID: input.sessionID,
        initiator: input.initiator,
        action: "control.ack",
        result: ack.status,
        reason: ack.reason,
        meta: { seq: input.seq },
      })
      return ack
    }

    await setLastSeq(input.sessionID, input.seq)
    try {
      switch (input.action) {
        case "cancel": {
          SessionPrompt.cancel(input.sessionID)
          break
        }
        case "pause": {
          await SessionPrompt.cancel(input.sessionID)
          break
        }
        case "resume": {
          // resume is intentionally no-op at this layer; next prompt/autonomous queue resumes work
          break
        }
        case "snapshot": {
          // implemented by caller; control channel only acknowledges
          break
        }
        case "set_priority": {
          break
        }
      }
      const ack = {
        requestID: input.requestID,
        sessionID: input.sessionID,
        seq: input.seq,
        status: "accepted" as const,
        timestamp: Date.now(),
      }
      await writeAudit({
        requestID: input.requestID,
        sessionID: input.sessionID,
        initiator: input.initiator,
        action: "control.ack",
        result: ack.status,
        meta: { seq: input.seq, action: input.action },
      })
      return ack
    } catch (error: any) {
      const ack = {
        requestID: input.requestID,
        sessionID: input.sessionID,
        seq: input.seq,
        status: "error" as const,
        reason: error?.message ?? String(error),
        timestamp: Date.now(),
      }
      await writeAudit({
        requestID: input.requestID,
        sessionID: input.sessionID,
        initiator: input.initiator,
        action: "control.ack",
        result: ack.status,
        reason: ack.reason,
        meta: { seq: input.seq, action: input.action },
      })
      return ack
    }
  }

  export async function publishControl(input: {
    requestID: string
    sessionID: string
    seq: number
    action: ControlAction
    initiator: string
    timeoutMs?: number
  }) {
    const transport = await resolveControlTransport()
    const timeoutMs = input.timeoutMs ?? 5000
    await writeAudit({
      requestID: input.requestID,
      sessionID: input.sessionID,
      initiator: input.initiator,
      action: "control.publish",
      meta: { seq: input.seq, action: input.action },
    })

    try {
      const ack = await transport.publishAndAwaitAck({ ...input, timeoutMs })
      return Ack.parse(ack)
    } catch (error: any) {
      await writeAudit({
        requestID: input.requestID,
        sessionID: input.sessionID,
        initiator: input.initiator,
        action: "control.timeout",
        reason: error?.message ?? String(error),
        meta: { seq: input.seq, action: input.action },
      })
      throw error
    }
  }

  export async function forceKill(sessionID: string, requestID: string, initiator: string, reason = "ack_timeout") {
    SessionPrompt.cancel(sessionID)
    await writeAudit({
      requestID,
      sessionID,
      initiator,
      action: "worker.force_kill",
      reason,
    })
  }

  export async function listBusySessionIDs(workspaceId?: string) {
    const statuses = SessionStatus.list()
    const allBusy = Object.entries(statuses)
      .filter(([, value]) => value.type !== "idle")
      .map(([sessionID]) => sessionID)

    if (!workspaceId) return allBusy

    // Workspace-scoped filter: resolve workspace from session directory.
    // Busy count is typically very small (1-3), so parallel lookup is fast.
    const { resolveWorkspace } = await import("@/project/workspace/resolver")
    const results = await Promise.all(
      allBusy.map(async (sessionID) => {
        const info = await Session.get(sessionID).catch(() => undefined)
        if (!info) return { sessionID, match: false }
        try {
          const ws = await resolveWorkspace({ directory: info.directory })
          return { sessionID, match: ws.workspaceId === workspaceId }
        } catch {
          return { sessionID, match: false }
        }
      }),
    )
    return results.filter((r) => r.match).map((r) => r.sessionID)
  }

  /**
   * Assert scheduling is allowed, with optional workspace scope (DD-16).
   *
   * - Global kill-switch (no workspaceId) blocks everything.
   * - Workspace-scoped kill-switch (workspaceId set) only blocks that workspace.
   * - If caller provides workspaceId, a workspace-scoped kill-switch for a
   *   different workspace does NOT block.
   */
  export async function assertSchedulingAllowed(workspaceId?: string) {
    const state = await getState()
    if (!state || !state.active) return { ok: true as const }

    // Global kill-switch blocks all workspaces
    if (state.scope === "global" || !state.workspaceId) {
      return { ok: false as const, state }
    }

    // Workspace-scoped kill-switch: only block the target workspace
    if (workspaceId && state.workspaceId !== workspaceId) {
      return { ok: true as const }
    }

    return { ok: false as const, state }
  }

  export async function createSnapshotPlaceholder(input: {
    requestID: string
    initiator: string
    mode: string
    scope: string
    reason: string
  }) {
    const backend = await resolveSnapshotBackend()
    try {
      return await backend.create(input)
    } catch (error: any) {
      await writeAudit({
        requestID: input.requestID,
        initiator: input.initiator,
        action: "snapshot.failure",
        reason: error?.message ?? String(error),
      })
      log.warn("snapshot write failed", { error })
      return null
    }
  }

  function createLocalControlTransport(): ControlTransport {
    return {
      async publishAndAwaitAck(input) {
        const timeoutMs = input.timeoutMs ?? 5000
        const work = handleControl(input)
        const timeout = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("ACK timeout")), timeoutMs)
        })
        return (await Promise.race([work, timeout])) as z.infer<typeof Ack>
      },
    }
  }

  async function resolveControlTransport(): Promise<ControlTransport> {
    return createLocalControlTransport()
  }

  function createLocalSnapshotBackend(): SnapshotBackend {
    return {
      async create(input) {
        const key = `snapshot-${input.requestID}.json`
        const snapshot = {
          requestID: input.requestID,
          initiator: input.initiator,
          mode: input.mode,
          scope: input.scope,
          reason: input.reason,
          activeSessions: listBusySessionIDs(),
          capturedAt: Date.now(),
          source: "local",
        }
        await Storage.write(["killswitch", "snapshot", input.requestID], snapshot)
        return `local://killswitch/${key}`
      },
    }
  }

  async function resolveSnapshotBackend(): Promise<SnapshotBackend> {
    return createLocalSnapshotBackend()
  }
}
