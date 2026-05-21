import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import { DaemonStartupLog } from "../../src/server/daemon-startup-log"
import { RestartHandover } from "../../src/server/restart-handover"

describe("daemon startup log", () => {
  test("writes startup evidence linked to the pending restart checkpoint", async () => {
    const txid = `test-startup-${process.pid}-${Date.now()}`
    const handover = await RestartHandover.write({
      txid,
      runtimeMode: "gateway-daemon",
      targets: ["daemon"],
      reason: "startup evidence test",
    })

    const result = await DaemonStartupLog.record({ port: 1080, hostname: "0.0.0.0", socketPath: "/tmp/opencode.sock" })
    const raw = await fs.readFile(result.path, "utf8")
    const last = raw
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as DaemonStartupLog.Record)
      .at(-1)

    expect(last?.event).toBe("daemon-started")
    expect(last?.restartTxid).toBe(txid)
    expect(last?.restartCheckpointPath).toBe(handover.path)
    expect(last?.port).toBe(1080)
    expect(last?.socketPath).toBe("/tmp/opencode.sock")

    const checkpoint = JSON.parse(await fs.readFile(handover.path, "utf8")) as RestartHandover.Checkpoint
    expect(checkpoint.status).toBe("restart-completed")
    expect(checkpoint.completedBy?.socketPath).toBe("/tmp/opencode.sock")

    const pending = JSON.parse(await fs.readFile(RestartHandover.pendingPath(), "utf8")) as {
      status: string
      txid: string
    }
    expect(pending.status).toBe("restart-completed")
    expect(pending.txid).toBe(txid)
  })

  test("does not link completed restart markers to later daemon starts", async () => {
    const txid = `test-completed-${process.pid}-${Date.now()}`
    const handover = await RestartHandover.write({
      txid,
      runtimeMode: "gateway-daemon",
      targets: ["daemon"],
      reason: "completed marker test",
    })
    await RestartHandover.complete({
      txid,
      checkpointPath: handover.path,
      startupLogPath: DaemonStartupLog.logPath(),
      pid: process.pid,
      ppid: process.ppid,
      socketPath: "/tmp/already-completed.sock",
    })

    const result = await DaemonStartupLog.record({ socketPath: "/tmp/opencode-after-completed.sock" })
    const raw = await fs.readFile(result.path, "utf8")
    const last = raw
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as DaemonStartupLog.Record)
      .at(-1)

    expect(last?.event).toBe("daemon-started")
    expect(last?.restartTxid).toBeUndefined()
    expect(last?.restartCheckpointPath).toBeUndefined()
    expect(last?.socketPath).toBe("/tmp/opencode-after-completed.sock")
  })
})
