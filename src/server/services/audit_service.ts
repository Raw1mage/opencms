import redisClient from "./redis_client"

const AUDIT_LIST_KEY = "audit:ledger"

export async function writeAudit(entry: Record<string, any>) {
  const payload = JSON.stringify({ ...entry, ts: new Date().toISOString() })
  await redisClient.rpush(AUDIT_LIST_KEY, payload)
  // also set a short-lived index by request_id if present for quick lookups
  if (entry.request_id) {
    const key = `audit:by_request:${entry.request_id}`
    await redisClient.set(key, payload)
  }
}

export async function readRecentAudit(limit = 100) {
  const items = await redisClient.lrange(AUDIT_LIST_KEY, -limit, -1)
  return items.map((s: string) => JSON.parse(s))
}

export async function readAuditByRequest(request_id: string) {
  const key = `audit:by_request:${request_id}`
  const v = await redisClient.get(key)
  return v ? JSON.parse(v) : null
}
