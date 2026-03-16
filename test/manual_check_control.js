#!/usr/bin/env node
// manual test script for control channel behaviors
;(async () => {
  const path = require("path")
  const base = "/home/pkcs12/projects/opencode"
  const redisClient = require(path.join(base, "src/server/services/redis_client.js")).default
  const { publishControl } = require(path.join(base, "src/server/control/control_channel.js"))
  const { handleControl } = require(path.join(base, "src/server/worker/worker_control_handler.js"))

  console.log("Starting manual control checks...")

  // 1) publishControl timeout path
  try {
    const reqId = `mtest-timeout-${Date.now()}`
    console.log("Testing publishControl timeout (expecting ACK timeout)...")
    await publishControl({ request_id: reqId, action: "cancel", seq: Date.now(), initiator: "tester" }, 1000)
    console.error("ERROR: publishControl unexpectedly succeeded")
  } catch (e) {
    console.log("publishControl timeout test passed:", e.message)
  }

  // 2) worker seq enforcement: set last_seq high, then send lower seq and check ack
  try {
    const reqId2 = `mtest-seq-${Date.now()}`
    const high = Date.now()
    const lowSeq = high - 1000
    const lastKey = `control:last_seq:${reqId2}`
    await redisClient.set(lastKey, String(high))
    // simulate worker handling a lower seq
    await handleControl({ request_id: reqId2, seq: lowSeq, action: "cancel" })
    const ackKey = `control:ack:${reqId2}:${lowSeq}`
    const v = await redisClient.get(ackKey)
    if (!v) {
      console.error("ERROR: expected ack key to be written for rejected seq")
    } else {
      console.log("Seq enforcement ack: ", v)
    }
  } catch (e) {
    console.error("Seq enforcement test error:", e)
  }

  process.exit(0)
})()
