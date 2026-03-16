import { describe, expect, it } from "bun:test"
import { KillSwitchService } from "./service"

describe("KillSwitchService", () => {
  it("generates and verifies MFA", async () => {
    const requestID = await KillSwitchService.idempotentRequestID("tester", "reason", 1000)
    const code = await KillSwitchService.generateMfa(requestID, "tester")
    expect(code.length).toBe(6)
    const ok = await KillSwitchService.verifyMfa(requestID, "tester", code)
    expect(ok).toBe(true)
  })

  it("rejects stale seq", async () => {
    const requestID = await KillSwitchService.idempotentRequestID("tester", "seq-case", 1000)
    const sessionID = "ses_test_seq"
    const first = await KillSwitchService.publishControl({
      requestID,
      sessionID,
      seq: 100,
      action: "snapshot",
      initiator: "tester",
      timeoutMs: 2000,
    })
    expect(first.status).toBe("accepted")
    const second = await KillSwitchService.publishControl({
      requestID,
      sessionID,
      seq: 99,
      action: "snapshot",
      initiator: "tester",
      timeoutMs: 2000,
    })
    expect(second.status).toBe("rejected")
  })

  it("creates local snapshot", async () => {
    const result = await KillSwitchService.createSnapshotPlaceholder({
      requestID: "ks_test_local",
      initiator: "tester",
      mode: "global",
      scope: "global",
      reason: "test local snapshot",
    })
    expect(result).toContain("local://killswitch/")
    expect(result).toContain("ks_test_local")
  })
})
