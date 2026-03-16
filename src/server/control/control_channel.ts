import { v4 as uuidv4 } from "uuid"
import redisClient, { redisPublish, redisSubscribe } from "../services/redis_client"
import { writeAudit } from "../services/audit_service"

const CONTROL_CHANNEL = "opencode:control"

// publish a control message and wait for ack (via Redis key)
export async function publishControl(
  msg: { request_id: string; action: string; seq: number; initiator: string },
  timeoutMs = 5000,
) {
  const envelope = { ...msg, ts: new Date().toISOString() }
  const payload = JSON.stringify(envelope)

  // store pending ack key
  const pendingKey = `control:pending:${msg.request_id}:${msg.seq}`
  await redisClient.set(pendingKey, JSON.stringify({ initiator: msg.initiator, ts: new Date().toISOString() }))
  await redisClient.expire(pendingKey, Math.ceil((timeoutMs + 1000) / 1000))

  // publish
  await redisPublish(CONTROL_CHANNEL, payload)

  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const ackKey = `control:ack:${msg.request_id}:${msg.seq}`
    const v = await redisClient.get(ackKey)
    if (v) {
      // got ack
      await redisClient.del(pendingKey)
      await redisClient.del(ackKey)
      const ack = JSON.parse(v)
      await writeAudit({
        request_id: msg.request_id,
        action: "control.ack",
        meta: { seq: msg.seq, ack },
        initiator: msg.initiator,
      })
      return ack
    }
    // small sleep
    await new Promise((r) => setTimeout(r, 150))
  }

  // timeout
  await writeAudit({
    request_id: msg.request_id,
    action: "control.timeout",
    meta: { seq: msg.seq },
    initiator: msg.initiator,
  })
  throw new Error("ACK timeout")
}

// subscribe helper (worker will use this)
export function subscribeControl(handler: (msg: any) => Promise<void>) {
  const sub = redisSubscribe(CONTROL_CHANNEL, async (message) => {
    try {
      const parsed = JSON.parse(message)
      await handler(parsed)
    } catch (e) {
      console.error("[control] subscribe handler error", e)
    }
  })
  return sub
}

// worker should call this to ack
export async function ackControl(request_id: string, seq: number, status = "accepted", reason?: string) {
  const ackKey = `control:ack:${request_id}:${seq}`
  const payload = JSON.stringify({ status, reason, ts: new Date().toISOString() })
  await redisClient.set(ackKey, payload)
  await writeAudit({ request_id, action: "control.ack.write", meta: { seq, status, reason } })
}
