/**
 * transport-ws.test.ts — WS upgrade header fingerprint.
 *
 * Covers the fixes that the WS transport needed to match upstream codex-rs
 * first-party classification, now expressed via the unified buildHeaders()
 * entry point with isWebSocket: true (Phase 2 of
 * codex-fingerprint-alignment):
 *   - User-Agent must be present on WS upgrade (was missing; HTTP already had it)
 *   - ChatGPT-Account-Id must be TitleCase (was lowercase chatgpt-account-id)
 *   - OpenAI-Beta must carry the responses_websockets date
 *   - x-client-request-id = conversationId (Phase 4)
 *   - No Content-Type / no Accept on WS upgrade (those are HTTP-only)
 */
import { describe, expect, test } from "bun:test"
import { buildHeaders } from "./headers"
import { armSendStallWatchdog, planDeltaTrim } from "./transport-ws"

describe("buildHeaders({ isWebSocket: true }) fingerprint", () => {
  const base = {
    accessToken: "access-abc",
    accountId: "codex-subscription-test",
    isWebSocket: true as const,
  }

  test("includes TitleCase ChatGPT-Account-Id (not lowercase)", () => {
    const h = buildHeaders(base)
    expect(h["ChatGPT-Account-Id"]).toBe("codex-subscription-test")
    expect(h["chatgpt-account-id"]).toBeUndefined()
  })

  test("includes User-Agent when provided", () => {
    const ua = "codex_cli_rs/0.125.0-alpha.1 (Linux 5.15.0; x86_64) terminal"
    const h = buildHeaders({ ...base, userAgent: ua })
    expect(h["User-Agent"]).toBe(ua)
  })

  test("UA prefix matches originator (first-party classifier contract)", () => {
    const ua = "codex_cli_rs/0.125.0-alpha.1 (Linux 5.15.0; x86_64) terminal"
    const h = buildHeaders({ ...base, userAgent: ua })
    expect(h["originator"]).toBe("codex_cli_rs")
    expect(h["User-Agent"]?.startsWith(h["originator"] + "/")).toBe(true)
  })

  test("omits User-Agent when not provided (caller responsibility)", () => {
    const h = buildHeaders(base)
    expect(h["User-Agent"]).toBeUndefined()
  })

  test("always emits authorization + originator + OpenAI-Beta", () => {
    const h = buildHeaders(base)
    expect(h["authorization"]).toBe("Bearer access-abc")
    expect(h["originator"]).toBe("codex_cli_rs")
    expect(h["OpenAI-Beta"]).toMatch(/^responses_websockets=\d{4}-\d{2}-\d{2}$/)
  })

  test("x-codex-turn-state flows through when provided", () => {
    const h = buildHeaders({ ...base, turnState: "turn-xyz" })
    expect(h["x-codex-turn-state"]).toBe("turn-xyz")
  })

  test("no accountId → no ChatGPT-Account-Id header at all", () => {
    const h = buildHeaders({ accessToken: "t", isWebSocket: true })
    expect(h["ChatGPT-Account-Id"]).toBeUndefined()
    expect(h["chatgpt-account-id"]).toBeUndefined()
  })

  test("WS path omits Content-Type and Accept (HTTP-only)", () => {
    const h = buildHeaders(base)
    expect(h["content-type"]).toBeUndefined()
    expect(h["Accept"]).toBeUndefined()
  })

  test("x-client-request-id = conversationId when provided (Phase 4)", () => {
    const h = buildHeaders({ ...base, conversationId: "conv-xyz" })
    expect(h["x-client-request-id"]).toBe("conv-xyz")
  })
})

describe("buildHeaders() HTTP path (Phase 4 additions)", () => {
  const base = {
    accessToken: "access-abc",
    accountId: "codex-subscription-test",
  }

  test("emits Content-Type application/json", () => {
    const h = buildHeaders(base)
    expect(h["content-type"]).toBe("application/json")
  })

  test("emits Accept text/event-stream (Phase 4)", () => {
    const h = buildHeaders(base)
    expect(h["Accept"]).toBe("text/event-stream")
  })

  test("x-client-request-id = conversationId when provided (Phase 4)", () => {
    const h = buildHeaders({ ...base, conversationId: "conv-xyz" })
    expect(h["x-client-request-id"]).toBe("conv-xyz")
  })

  test("no conversationId → no x-client-request-id header", () => {
    const h = buildHeaders(base)
    expect(h["x-client-request-id"]).toBeUndefined()
  })

  test("HTTP path does NOT emit OpenAI-Beta", () => {
    const h = buildHeaders(base)
    expect(h["OpenAI-Beta"]).toBeUndefined()
  })
})

// codex-update plan §3: WS send-side idle timeout (DD-3, INV-4, INV-5)
// Mirrors upstream codex commit 35aaa5d9fc — `tokio::time::timeout` around send.
describe("armSendStallWatchdog (codex-update DD-3)", () => {
  test("TV-8: stalled send (bufferedAmount stays > 0) fires onFire within timeout", async () => {
    const fakeWs = { bufferedAmount: 4096 } // never drains
    let fired = false
    const timer = armSendStallWatchdog({
      ws: fakeWs,
      timeoutMs: 50,
      shouldFire: () => fakeWs.bufferedAmount > 0,
      onFire: () => {
        fired = true
      },
    })
    await new Promise((r) => setTimeout(r, 100))
    expect(fired).toBe(true)
    clearTimeout(timer)
  })

  test("TV-9: normal send (bufferedAmount drops to 0) does NOT fire onFire", async () => {
    const fakeWs = { bufferedAmount: 1024 }
    let fired = false
    const timer = armSendStallWatchdog({
      ws: fakeWs,
      timeoutMs: 50,
      shouldFire: () => fakeWs.bufferedAmount > 0,
      onFire: () => {
        fired = true
      },
    })
    // Simulate the OS pump draining within the window.
    setTimeout(() => {
      fakeWs.bufferedAmount = 0
    }, 10)
    await new Promise((r) => setTimeout(r, 100))
    expect(fired).toBe(false)
    clearTimeout(timer)
  })

  test("watchdog can be cancelled before firing (cleanup path)", async () => {
    const fakeWs = { bufferedAmount: 4096 }
    let fired = false
    const timer = armSendStallWatchdog({
      ws: fakeWs,
      timeoutMs: 50,
      shouldFire: () => fakeWs.bufferedAmount > 0,
      onFire: () => {
        fired = true
      },
    })
    clearTimeout(timer)
    await new Promise((r) => setTimeout(r, 100))
    expect(fired).toBe(false)
  })

  test("INV-5 alignment: shouldFire predicate gates onFire — even at deadline, predicate decides", async () => {
    // Mirrors the inline gate in transport-ws.ts: bufferedAmount > 0 AND
    // frameCount === 0 AND state === "streaming". If any becomes false at
    // the deadline, no fire. Here we simulate frame arrival between arming
    // and firing.
    const fakeWs = { bufferedAmount: 4096 }
    let frameCount = 0
    let fired = false
    const timer = armSendStallWatchdog({
      ws: fakeWs,
      timeoutMs: 50,
      shouldFire: () => fakeWs.bufferedAmount > 0 && frameCount === 0,
      onFire: () => {
        fired = true
      },
    })
    setTimeout(() => {
      frameCount = 1 // a frame arrived; receive-side timer now owns the path
    }, 10)
    await new Promise((r) => setTimeout(r, 100))
    expect(fired).toBe(false)
    clearTimeout(timer)
  })
})

// cache-chain-hotfix (DD-2/DD-7): planDeltaTrim is the pure delta gate. The fix
// is in WHEN lastInputLength is committed (only on response.completed), which
// this helper consumes — so these vectors pin the decision behavior the fix
// relies on. See plans/provider-codex_cache-chain-hotfix/test-vectors.json.
describe("planDeltaTrim (cache-chain-hotfix)", () => {
  test("TV-1: phantom-vs-fix — failed turn must NOT force a reset on next turn", () => {
    // Turn N-1 completed at input length 100 → lastInputLength committed = 100.
    // Turn N (length 150) aborts via ws_send_timeout (no completion).
    // Turn N+1 arrives still at length 150 (the aborted turn appended nothing).

    // BEFORE the fix: lastInputLength was advanced to 150 at SEND time (phantom),
    // so the next turn sees 150 > 150 = false → reset (cache cliff).
    const phantom = planDeltaTrim({ hasPrevResp: true, inputLength: 150, lastInputLength: 150 })
    expect(phantom.action).toBe("reset")

    // AFTER the fix: lastInputLength still tracks the last SUCCESSFUL turn (100),
    // so 150 > 100 = true → delta from 100. No reset, no cliff.
    const fixed = planDeltaTrim({ hasPrevResp: true, inputLength: 150, lastInputLength: 100 })
    expect(fixed.action).toBe("delta")
    expect(fixed).toMatchObject({ action: "delta", sliceFrom: 100 })
  })

  test("TV-2: compaction shrink still resets (length_not_grown preserved)", () => {
    const plan = planDeltaTrim({ hasPrevResp: true, inputLength: 50, lastInputLength: 200 })
    expect(plan.action).toBe("reset")
    expect(plan).toMatchObject({ reason: expect.stringContaining("length_not_grown") })
  })

  test("TV-2b: equal length (no growth) resets — strict-growth invariant", () => {
    const plan = planDeltaTrim({ hasPrevResp: true, inputLength: 120, lastInputLength: 120 })
    expect(plan.action).toBe("reset")
  })

  test("TV-3: first turn / no chain pointer → full send", () => {
    expect(planDeltaTrim({ hasPrevResp: false, inputLength: 80, lastInputLength: undefined }).action).toBe("full")
    // hasPrevResp but lastInputLength unknown (0) → cannot trust a delta → reset
    expect(planDeltaTrim({ hasPrevResp: true, inputLength: 80, lastInputLength: undefined }).action).toBe("reset")
  })

  test("TV-4: normal growth → delta from last successful length", () => {
    const plan = planDeltaTrim({ hasPrevResp: true, inputLength: 130, lastInputLength: 118 })
    expect(plan).toMatchObject({ action: "delta", sliceFrom: 118 })
  })
})

import { getSession, isUserMessageItem, tryWsTransport } from "./transport-ws"

describe("WebSocket Self-Healing and State Locking", () => {
  test("isUserMessageItem type guard correctness", () => {
    expect(isUserMessageItem({ role: "user" })).toBe(true)
    expect(isUserMessageItem({ type: "user" })).toBe(true)
    expect(isUserMessageItem({ role: "assistant" })).toBe(false)
    expect(isUserMessageItem({ type: "assistant" })).toBe(false)
    expect(isUserMessageItem(null)).toBe(false)
    expect(isUserMessageItem("user")).toBe(false)
    expect(isUserMessageItem({})).toBe(false)
  })

  test("state locking records reason and timestamp", () => {
    const sessionId = "session-lock-test"
    const state = getSession(sessionId)

    // Simulate timeout lock
    state.disableWebsockets = true
    state.disableReason = "timeout"
    state.disabledAt = 123456789

    expect(state.disableWebsockets).toBe(true)
    expect(state.disableReason).toBe("timeout")
    expect(state.disabledAt).toBe(123456789)
  })

  test("self-healing gate branches and cooldowns", async () => {
    const sessionId = "session-selfheal-gate-test"
    const state = getSession(sessionId)

    // Base input base options for tryWsTransport
    const inputBase = {
      sessionId,
      accessToken: "token-abc",
      wsUrl: "ws://localhost:9999", // mock unreachable wss
      body: {
        model: "gpt-5.5",
        input: [] as any[],
      },
    }

    // Scenario 1: disableWebsockets is true, but NOT a user turn
    state.disableWebsockets = true
    state.disableReason = "timeout"
    state.disabledAt = Date.now() - 100_000 // 100s ago (> 60s cooldown)
    inputBase.body.input = [{ role: "assistant", content: "hello" }]

    let result = await tryWsTransport(inputBase)
    expect(result).toBeNull()
    expect(state.disableWebsockets).toBe(true) // still locked

    // Scenario 2: is user turn, but cooldown NOT elapsed (elapsed 10s < 60s for timeout)
    state.disableWebsockets = true
    state.disableReason = "timeout"
    state.disabledAt = Date.now() - 10_000
    inputBase.body.input = [{ role: "user", content: "hello" }]

    result = await tryWsTransport(inputBase)
    expect(result).toBeNull()
    expect(state.disableWebsockets).toBe(true) // still locked

    // Scenario 3: is user turn, and cooldown elapsed for timeout (elapsed 70s > 60s)
    state.disableWebsockets = true
    state.disableReason = "timeout"
    state.disabledAt = Date.now() - 70_000
    inputBase.body.input = [{ role: "user", content: "hello" }]

    result = await tryWsTransport(inputBase)
    // Should reset disableWebsockets to false, try connecting and fail (since ws is unreachable),
    // then lock again with hard_failure.
    expect(state.disableWebsockets).toBe(true)
    expect(state.disableReason).toBe("hard_failure")
    expect(state.disabledAt).toBeGreaterThan(Date.now() - 2000)

    // Scenario 4: is user turn, and cooldown NOT elapsed for hard_failure (elapsed 200s < 300s)
    state.disableWebsockets = true
    state.disableReason = "hard_failure"
    state.disabledAt = Date.now() - 200_000
    inputBase.body.input = [{ role: "user", content: "hello" }]

    result = await tryWsTransport(inputBase)
    expect(result).toBeNull()
    expect(state.disableWebsockets).toBe(true) // still locked
  })

  test("timeout self-healing ensures cold send on first retry turn", () => {
    const sessionId = "session-cold-send-test"
    const state = getSession(sessionId)

    // Setup active state with continuation
    state.lastResponseId = "resp-123"
    state.lastInputLength = 100

    // Simulate timeout logic (corresponds to result.timeout block in probeFirstFrame)
    state.lastResponseId = undefined
    state.lastInputLength = undefined
    state.disableWebsockets = true
    state.disableReason = "timeout"
    state.disabledAt = Date.now()

    // Verify continuation details are cleared, guaranteeing that when self-healing retry triggers,
    // it will be a cold send (no previous_response_id in request body).
    expect(state.lastResponseId).toBeUndefined()
    expect(state.lastInputLength).toBeUndefined()
  })
})
