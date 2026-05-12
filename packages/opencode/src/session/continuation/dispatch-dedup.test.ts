import { afterEach, describe, expect, it } from "bun:test"
import { dedupKeyFor, DispatchDedup } from "./dispatch-dedup"

afterEach(() => {
  DispatchDedup.reset()
})

const S = "ses_dedup_test"

describe("dedupKeyFor", () => {
  it("account_switch → kind:prev→next key", () => {
    expect(
      dedupKeyFor({
        kind: "account_switch",
        sessionID: S,
        previousAccountId: "A1",
        accountId: "A2",
        providerId: "codex",
      }),
    ).toBe("account_switch:A1→A2")
  })

  it("account_rotate → kind:prev→next key", () => {
    expect(
      dedupKeyFor({
        kind: "account_rotate",
        sessionID: S,
        previousAccountId: "A1",
        accountId: "A2",
        providerId: "codex",
        trigger: "quota",
      }),
    ).toBe("account_rotate:A1→A2")
  })

  it("provider_switch → kind:prev→next key", () => {
    expect(
      dedupKeyFor({
        kind: "provider_switch",
        sessionID: S,
        previousProviderId: "codex",
        providerId: "claude-cli",
      }),
    ).toBe("provider_switch:codex→claude-cli")
  })

  it("model_switch_same_family / cross_family → modelID transition key", () => {
    expect(
      dedupKeyFor({
        kind: "model_switch_same_family",
        sessionID: S,
        previousModelId: "gpt-5.5",
        modelId: "gpt-5.4",
        providerId: "codex",
      }),
    ).toBe("model_switch_same_family:gpt-5.5→gpt-5.4")
    expect(
      dedupKeyFor({
        kind: "model_switch_cross_family",
        sessionID: S,
        previousModelId: "gpt-5",
        modelId: "o4-mini",
        providerId: "codex",
      }),
    ).toBe("model_switch_cross_family:gpt-5→o4-mini")
  })

  it("one-shot kinds return null (no dedup)", () => {
    expect(dedupKeyFor({ kind: "empty_response_recovery", sessionID: S, emptyRoundCount: 1 })).toBeNull()
    expect(
      dedupKeyFor({
        kind: "compaction_narrative",
        sessionID: S,
        anchorId: "anchor_x",
        providerId: "codex",
      }),
    ).toBeNull()
    expect(
      dedupKeyFor({
        kind: "backend_failure_forced_resend",
        sessionID: S,
        classifier: "ws_truncation",
        providerId: "codex",
      }),
    ).toBeNull()
    expect(dedupKeyFor({ kind: "ws_reconnect", sessionID: S })).toBeNull()
    expect(dedupKeyFor({ kind: "user_clear", sessionID: S })).toBeNull()
    expect(
      dedupKeyFor({
        kind: "subagent_spawn",
        sessionID: S,
        parentSessionID: "p",
      }),
    ).toBeNull()
  })
})

describe("DispatchDedup", () => {
  it("first dispatch is allowed", () => {
    expect(DispatchDedup.shouldDispatch(S, "k1")).toBe(true)
  })

  it("null key always dispatches (one-shot)", () => {
    DispatchDedup.record(S, null)
    expect(DispatchDedup.shouldDispatch(S, null)).toBe(true)
  })

  it("same key within TTL is suppressed", () => {
    const now = 1_000_000
    DispatchDedup.record(S, "k1", now)
    expect(DispatchDedup.shouldDispatch(S, "k1", now + 1_000)).toBe(false)
  })

  it("same key past TTL is allowed again", () => {
    const now = 1_000_000
    const ttlMs = 5 * 60 * 1000
    DispatchDedup.record(S, "k1", now)
    expect(DispatchDedup.shouldDispatch(S, "k1", now + ttlMs + 1)).toBe(true)
  })

  it("different key always allowed (different prev→next pair)", () => {
    const now = 1_000_000
    DispatchDedup.record(S, "account_switch:A→B", now)
    expect(DispatchDedup.shouldDispatch(S, "account_switch:B→A", now + 100)).toBe(true)
    expect(DispatchDedup.shouldDispatch(S, "account_switch:C→D", now + 100)).toBe(true)
  })

  it("different sessions isolate their dedup state", () => {
    DispatchDedup.record("ses_a", "k1")
    expect(DispatchDedup.shouldDispatch("ses_b", "k1")).toBe(true)
  })

  it("clear(sessionID) removes the entry", () => {
    DispatchDedup.record(S, "k1")
    DispatchDedup.clear(S)
    expect(DispatchDedup.shouldDispatch(S, "k1")).toBe(true)
  })

  it("size reflects active entries", () => {
    DispatchDedup.record("a", "k")
    DispatchDedup.record("b", "k")
    DispatchDedup.record("c", "k")
    expect(DispatchDedup.size()).toBe(3)
    DispatchDedup.reset()
    expect(DispatchDedup.size()).toBe(0)
  })

  it("peek returns the stored entry", () => {
    const ts = 12345
    DispatchDedup.record(S, "abc", ts)
    expect(DispatchDedup.peek(S)).toEqual({ key: "abc", ts })
  })
})
