import { afterEach, describe, expect, it, mock } from "bun:test"
import { SessionCompaction } from "./compaction"
import { Session } from "."
import { PendingInjectionStore } from "./continuation/pending-injection"

/**
 * 2026-05-13 amend test — `shouldInjectContinue` chain-init-pending override.
 *
 * Spec: specs/compaction/user-msg-replay-unification + specs/session/
 * rebind-procedure-revision rev4 (cross-amend).
 *
 * Behaviour matrix:
 *
 * | observed | PendingInjection mark | user msg post-anchor | expected |
 * |---|---|---|---|
 * | overflow (INJECT_CONTINUE=true) | n/a | absent  | true  (legacy, unchanged) |
 * | overflow (INJECT_CONTINUE=true) | n/a | present | false (replay handled it) |
 * | rebind (INJECT_CONTINUE=false)  | absent (phantom-detect path) | absent  | false (2026-04-27 defense preserved) |
 * | rebind (INJECT_CONTINUE=false)  | chainInit pending            | absent  | true  (real user-initiated rebind → AI continues) |
 * | rebind (INJECT_CONTINUE=false)  | chainInit pending            | present | false (replay handled it) |
 *
 * The pending-injection mark is the new signal that distinguishes
 * user-initiated rebind (which flowed through Continuation.run) from
 * the 2026-04-27 phantom detection (which did not). Without this
 * signal, the static `INJECT_CONTINUE[rebind]=false` table-of-last-resort
 * was the only defence; with it, we can safely re-enable Continue
 * injection for genuine user-initiated rebind.
 */

const originalSessionMessages = Session.messages

afterEach(() => {
  ;(Session as any).messages = originalSessionMessages
  PendingInjectionStore.reset()
})

const SID = "ses_amend_rev2"
const ANCHOR_ID = "msg_anchor_x"

function mockMessages(messages: Array<{ id: string; role: "user" | "assistant" }>) {
  ;(Session as any).messages = mock(async () => messages.map((m) => ({
    info: { id: m.id, role: m.role, sessionID: SID },
    parts: [],
  })))
}

function pendingMark(opts: { chainInit: boolean; amnesia: boolean }) {
  PendingInjectionStore.mark(SID, {
    chainInit: opts.chainInit,
    amnesia: opts.amnesia,
    digest: null,
    reason: "account_switch",
    ts: Date.now(),
  })
}

describe("shouldInjectContinue (amend rev2 + rebind-procedure-revision rev4)", () => {
  it("INJECT_CONTINUE=true / no user msg post-anchor → true (legacy preserved)", async () => {
    mockMessages([{ id: ANCHOR_ID, role: "assistant" }])
    const result = await SessionCompaction.__test__.shouldInjectContinue(SID, "overflow", ANCHOR_ID)
    expect(result).toBe(true)
  })

  it("INJECT_CONTINUE=true / user msg post-anchor → false (replay handled)", async () => {
    mockMessages([
      { id: ANCHOR_ID, role: "assistant" },
      { id: "msg_user_y_AFTER_anchor", role: "user" },
    ])
    const result = await SessionCompaction.__test__.shouldInjectContinue(SID, "overflow", ANCHOR_ID)
    expect(result).toBe(false)
  })

  it("INJECT_CONTINUE=false (rebind) / no PendingInjection / no user msg → false (2026-04-27 defense)", async () => {
    mockMessages([{ id: ANCHOR_ID, role: "assistant" }])
    const result = await SessionCompaction.__test__.shouldInjectContinue(SID, "rebind", ANCHOR_ID)
    expect(result).toBe(false)
  })

  it("INJECT_CONTINUE=false (rebind) / amnesia-only PendingInjection / no user msg → false (not chainInit)", async () => {
    mockMessages([{ id: ANCHOR_ID, role: "assistant" }])
    pendingMark({ chainInit: false, amnesia: true })
    const result = await SessionCompaction.__test__.shouldInjectContinue(SID, "rebind", ANCHOR_ID)
    expect(result).toBe(false)
  })

  it("INJECT_CONTINUE=false (rebind) / chainInit PendingInjection / no user msg → true (real user-initiated)", async () => {
    mockMessages([{ id: ANCHOR_ID, role: "assistant" }])
    pendingMark({ chainInit: true, amnesia: false })
    const result = await SessionCompaction.__test__.shouldInjectContinue(SID, "rebind", ANCHOR_ID)
    expect(result).toBe(true)
  })

  it("INJECT_CONTINUE=false (rebind) / chainInit PendingInjection / user msg post-anchor → false (replay handled it)", async () => {
    mockMessages([
      { id: ANCHOR_ID, role: "assistant" },
      { id: "msg_user_y_AFTER_anchor", role: "user" },
    ])
    pendingMark({ chainInit: true, amnesia: false })
    const result = await SessionCompaction.__test__.shouldInjectContinue(SID, "rebind", ANCHOR_ID)
    expect(result).toBe(false)
  })

  it("provider-switched + chainInit pending → behaves like rebind (consistent across false-default kinds)", async () => {
    mockMessages([{ id: ANCHOR_ID, role: "assistant" }])
    pendingMark({ chainInit: true, amnesia: false })
    const result = await SessionCompaction.__test__.shouldInjectContinue(SID, "provider-switched", ANCHOR_ID)
    expect(result).toBe(true)
  })

  it("continuation-invalidated + chainInit pending → true", async () => {
    mockMessages([{ id: ANCHOR_ID, role: "assistant" }])
    pendingMark({ chainInit: true, amnesia: false })
    const result = await SessionCompaction.__test__.shouldInjectContinue(SID, "continuation-invalidated", ANCHOR_ID)
    expect(result).toBe(true)
  })

  it("stall-recovery + no pending → false (2026-04-27-style defense)", async () => {
    mockMessages([{ id: ANCHOR_ID, role: "assistant" }])
    const result = await SessionCompaction.__test__.shouldInjectContinue(SID, "stall-recovery", ANCHOR_ID)
    expect(result).toBe(false)
  })

  it("session isolation: PendingInjection for sid_A doesn't leak into sid_B", async () => {
    mockMessages([{ id: ANCHOR_ID, role: "assistant" }])
    pendingMark({ chainInit: true, amnesia: false })
    // Different session id — should not see the mark
    const result = await SessionCompaction.__test__.shouldInjectContinue("ses_other_session", "rebind", ANCHOR_ID)
    expect(result).toBe(false)
  })
})
