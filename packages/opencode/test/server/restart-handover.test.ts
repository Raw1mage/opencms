import fs from "node:fs/promises"
import { RestartHandover } from "../../src/server/restart-handover"

describe("restart handover checkpoint", () => {
  test("writes a durable restart checkpoint with redacted continuation context", async () => {
    const txid = `test-restart-${process.pid}-${Date.now()}`
    const result = await RestartHandover.write({
      txid,
      runtimeMode: "gateway-daemon",
      targets: ["daemon"],
      reason: "apply runtime change token=secret-value",
      sessionID: "ses_test_restart",
      handover: "Continue after restart. api_key=abc123",
      errorLogPath: "/tmp/restart-error.log",
      webctlPath: "/etc/opencode/webctl.sh",
    })

    const raw = await fs.readFile(result.path, "utf8")
    const checkpoint = JSON.parse(raw) as RestartHandover.Checkpoint

    expect(checkpoint.schemaVersion).toBe(1)
    expect(checkpoint.txid).toBe(txid)
    expect(checkpoint.status).toBe("restart-requested")
    expect(checkpoint.sessionID).toBe("ses_test_restart")
    expect(checkpoint.reason).toContain("token=<redacted>")
    expect(checkpoint.handover).toContain("api_key=<redacted>")
    expect(checkpoint.validationNextSteps.join("\n")).toContain("do not infer restart success")

    const pendingRaw = await fs.readFile(RestartHandover.pendingPath(), "utf8")
    const pending = JSON.parse(pendingRaw) as { txid: string; checkpointPath: string }
    expect(pending.txid).toBe(txid)
    expect(pending.checkpointPath).toBe(result.path)
  })

  test("sanitizes txid before deriving the checkpoint path", () => {
    expect(RestartHandover.filePath("../bad txid")).toContain("..-bad-txid.json")
  })
})
