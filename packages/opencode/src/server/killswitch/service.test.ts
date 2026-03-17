import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { KillSwitchService } from "./service"
import { SessionStatus } from "@/session/status"

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

// --- Workspace-scoped kill-switch tests (Stage 4) ---

describe("KillSwitchService workspace scope", () => {
  it("global kill-switch blocks all workspaces", async () => {
    await KillSwitchService.setState({
      active: true,
      state: "soft_paused",
      requestID: "ks_global_test",
      initiator: "tester",
      reason: "test global",
      initiatedAt: Date.now(),
      mode: "global",
      scope: "global",
    })

    const resultA = await KillSwitchService.assertSchedulingAllowed("ws-a")
    expect(resultA.ok).toBe(false)

    const resultB = await KillSwitchService.assertSchedulingAllowed("ws-b")
    expect(resultB.ok).toBe(false)

    const resultNone = await KillSwitchService.assertSchedulingAllowed()
    expect(resultNone.ok).toBe(false)

    await KillSwitchService.clearState()
  })

  it("workspace-scoped kill-switch only blocks target workspace", async () => {
    await KillSwitchService.setState({
      active: true,
      state: "soft_paused",
      requestID: "ks_workspace_test",
      initiator: "tester",
      reason: "test workspace scope",
      initiatedAt: Date.now(),
      mode: "workspace",
      scope: "workspace",
      workspaceId: "ws-a",
    })

    // Workspace A should be blocked
    const resultA = await KillSwitchService.assertSchedulingAllowed("ws-a")
    expect(resultA.ok).toBe(false)

    // Workspace B should NOT be blocked
    const resultB = await KillSwitchService.assertSchedulingAllowed("ws-b")
    expect(resultB.ok).toBe(true)

    await KillSwitchService.clearState()
  })

  it("inactive kill-switch allows all workspaces", async () => {
    await KillSwitchService.clearState()

    const result = await KillSwitchService.assertSchedulingAllowed("ws-a")
    expect(result.ok).toBe(true)
  })
})

describe("KillSwitchService.listBusySessionIDs", () => {
  beforeEach(() => {
    SessionStatus.set("ses_a1", { type: "busy" })
    SessionStatus.set("ses_a2", { type: "busy" })
    SessionStatus.set("ses_b1", { type: "busy" })
  })

  afterEach(() => {
    SessionStatus.set("ses_a1", { type: "idle" })
    SessionStatus.set("ses_a2", { type: "idle" })
    SessionStatus.set("ses_b1", { type: "idle" })
  })

  it("returns all busy sessions when no workspaceId filter", async () => {
    const busy = await KillSwitchService.listBusySessionIDs()
    expect(busy.length).toBe(3)
    expect(busy).toContain("ses_a1")
    expect(busy).toContain("ses_a2")
    expect(busy).toContain("ses_b1")
  })

  it("returns empty when no sessions are busy", async () => {
    SessionStatus.set("ses_a1", { type: "idle" })
    SessionStatus.set("ses_a2", { type: "idle" })
    SessionStatus.set("ses_b1", { type: "idle" })
    const busy = await KillSwitchService.listBusySessionIDs()
    expect(busy.length).toBe(0)
  })
})
