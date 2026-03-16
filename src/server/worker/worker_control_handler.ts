import redisClient from "../services/redis_client"
import { subscribeControl, ackControl } from "../control/control_channel"

const LAST_SEQ_PREFIX = "control:last_seq:"

export async function handleControl(parsed: any) {
  const { request_id, seq, action } = parsed
  const lastKey = `${LAST_SEQ_PREFIX}${request_id}`
  const last = await redisClient.get(lastKey)
  const lastNum = last ? parseInt(last, 10) : 0
  if (seq <= lastNum) {
    // reject
    await ackControl(request_id, seq, "rejected", "seq_not_higher")
    return
  }
  // accept and persist
  await redisClient.set(lastKey, String(seq))
  // simulate handling
  console.log("[worker] handling control", request_id, seq, action)
  await ackControl(request_id, seq, "accepted")
}

export function startWorkerControlSubscriber() {
  subscribeControl(handleControl)
}
