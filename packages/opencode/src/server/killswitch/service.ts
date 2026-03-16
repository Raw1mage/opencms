import { Bus } from "@/bus"
import { Identifier } from "@/id/id"
import { Event } from "@/server/event"
import { SessionPrompt } from "@/session/prompt"
import { SessionStatus } from "@/session/status"
import { Storage } from "@/storage/storage"
import { Log } from "@/util/log"
import z from "zod"

const log = Log.create({ service: "killswitch" })

export namespace KillSwitchService {
  export class ControlTransportConfigError extends Error {}
  export class SnapshotBackendConfigError extends Error {}

  export const State = z.object({
    active: z.boolean(),
    state: z.enum(["soft_paused", "inactive"]),
    requestID: z.string(),
    initiator: z.string(),
    reason: z.string(),
    initiatedAt: z.number(),
    mode: z.string(),
    scope: z.string(),
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

  export function listBusySessionIDs() {
    const statuses = SessionStatus.list()
    return Object.entries(statuses)
      .filter(([, value]) => value.type !== "idle")
      .map(([sessionID]) => sessionID)
  }

  export async function assertSchedulingAllowed() {
    const state = await getState()
    if (!state || !state.active) return { ok: true as const }
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
      if (error instanceof SnapshotBackendConfigError) throw error
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

  let redisPub: import("ioredis").default | undefined
  let redisSub: import("ioredis").default | undefined

  async function getRedisClients(redisURL: string) {
    const { default: Redis } = await import("ioredis")
    if (!redisPub) redisPub = new Redis(redisURL, { lazyConnect: true, maxRetriesPerRequest: 1 })
    if (!redisSub) redisSub = new Redis(redisURL, { lazyConnect: true, maxRetriesPerRequest: 1 })
    return { pub: redisPub, sub: redisSub }
  }

  async function createRedisControlTransport(): Promise<ControlTransport> {
    const redisURL = process.env.OPENCODE_REDIS_URL
    if (!redisURL) {
      throw new ControlTransportConfigError(
        "control transport 'redis' selected but OPENCODE_REDIS_URL is not configured",
      )
    }
    const { pub, sub } = await getRedisClients(redisURL)

    return {
      async publishAndAwaitAck(input) {
        const timeoutMs = input.timeoutMs ?? 5000
        const controlChannel = `ks:control:${input.sessionID}`
        const ackChannel = `ks:ack:${input.requestID}:${input.seq}`

        await sub.connect().catch(() => {})
        await pub.connect().catch(() => {})

        const ackPromise = new Promise<z.infer<typeof Ack>>((resolve, reject) => {
          const timer = setTimeout(() => {
            sub.unsubscribe(ackChannel).catch(() => {})
            reject(new Error("ACK timeout"))
          }, timeoutMs)

          sub.subscribe(ackChannel, (err) => {
            if (err) {
              clearTimeout(timer)
              reject(err)
            }
          })

          sub.on("message", (channel, message) => {
            if (channel !== ackChannel) return
            clearTimeout(timer)
            sub.unsubscribe(ackChannel).catch(() => {})
            try {
              resolve(Ack.parse(JSON.parse(message)))
            } catch (e: any) {
              reject(new Error(`invalid ACK payload: ${e?.message}`))
            }
          })
        })

        const controlMessage = JSON.stringify({
          requestID: input.requestID,
          sessionID: input.sessionID,
          seq: input.seq,
          action: input.action,
          initiator: input.initiator,
        })
        await pub.publish(controlChannel, controlMessage)

        return ackPromise
      },
    }
  }

  export function resolveControlTransportMode() {
    return (process.env.OPENCODE_KILLSWITCH_CONTROL_TRANSPORT ?? "local").trim().toLowerCase()
  }

  async function resolveControlTransport(): Promise<ControlTransport> {
    const mode = resolveControlTransportMode()
    if (mode === "local") return createLocalControlTransport()
    if (mode === "redis") return await createRedisControlTransport()
    throw new ControlTransportConfigError(
      `unknown kill-switch control transport mode '${mode}', expected one of: local, redis`,
    )
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

  let _awsClientModule: typeof import("aws4fetch") | undefined
  let _cachedAwsClient: { key: string; client: InstanceType<typeof import("aws4fetch").AwsClient> } | undefined

  async function getAwsClientModule() {
    if (!_awsClientModule) _awsClientModule = await import("aws4fetch")
    return _awsClientModule
  }

  async function createMinioSnapshotBackend(): Promise<SnapshotBackend> {
    const endpoint = process.env.OPENCODE_MINIO_ENDPOINT
    const accessKey = process.env.OPENCODE_MINIO_ACCESS_KEY
    const secretKey = process.env.OPENCODE_MINIO_SECRET_KEY
    const bucket = process.env.OPENCODE_MINIO_BUCKET
    const region = process.env.OPENCODE_MINIO_REGION || "us-east-1"
    if (!endpoint || !accessKey || !secretKey || !bucket) {
      throw new SnapshotBackendConfigError(
        "snapshot backend 'minio' selected but required env is missing: OPENCODE_MINIO_ENDPOINT, OPENCODE_MINIO_ACCESS_KEY, OPENCODE_MINIO_SECRET_KEY, OPENCODE_MINIO_BUCKET",
      )
    }
    const cacheKey = `${accessKey}:${secretKey}:${region}`
    let client: InstanceType<typeof import("aws4fetch").AwsClient>
    if (_cachedAwsClient?.key === cacheKey) {
      client = _cachedAwsClient.client
    } else {
      const { AwsClient } = await getAwsClientModule()
      client = new AwsClient({ accessKeyId: accessKey, secretAccessKey: secretKey, region })
      _cachedAwsClient = { key: cacheKey, client }
    }
    const base = `${endpoint.replace(/\/$/, "")}/${bucket}`

    return {
      async create(input) {
        const snapshot = {
          requestID: input.requestID,
          initiator: input.initiator,
          mode: input.mode,
          scope: input.scope,
          reason: input.reason,
          activeSessions: listBusySessionIDs(),
          capturedAt: Date.now(),
          source: "minio",
        }
        const objectPath = `killswitch/snapshots/${input.requestID}.json`
        const url = `${base}/${objectPath}`
        const req = new Request(url, {
          method: "PUT",
          body: JSON.stringify(snapshot),
          headers: { "Content-Type": "application/json" },
        })
        const signed = await client.sign(req)
        const response = await fetch(signed)
        if (!response.ok) {
          throw new Error(`MinIO PUT failed: ${response.status} ${response.statusText}`)
        }
        log.info("snapshot uploaded to minio", { url, requestID: input.requestID })
        return url
      },
    }
  }

  export function resolveSnapshotBackendMode() {
    return (process.env.OPENCODE_KILLSWITCH_SNAPSHOT_BACKEND ?? "local").trim().toLowerCase()
  }

  async function resolveSnapshotBackend(): Promise<SnapshotBackend> {
    const mode = resolveSnapshotBackendMode()
    if (mode === "local") return createLocalSnapshotBackend()
    if (mode === "minio" || mode === "s3") return await createMinioSnapshotBackend()
    throw new SnapshotBackendConfigError(
      `unknown kill-switch snapshot backend mode '${mode}', expected one of: local, minio, s3`,
    )
  }
}
