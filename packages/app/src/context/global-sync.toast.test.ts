import { describe, expect, test } from "bun:test"
import { toastDisplayDecision } from "./global-sync"

describe("toastDisplayDecision", () => {
  test("shows fresh scoped toasts", () => {
    expect(
      toastDisplayDecision({ message: "ok", variant: "info", scope: "system", emittedAt: 1_000, ttlMs: 5_000 }, 2_000),
    ).toEqual({ show: true, traversalMs: 1_000, scope: "system" })
  })

  test("drops stale toasts", () => {
    expect(
      toastDisplayDecision(
        { message: "old", variant: "warning", scope: "user", emittedAt: 1_000, ttlMs: 5_000 },
        7_001,
      ),
    ).toEqual({ show: false, reason: "stale", traversalMs: 6_001 })
  })

  test("drops toasts missing freshness", () => {
    expect(toastDisplayDecision({ message: "old format", variant: "info", scope: "user" }, 2_000)).toEqual({
      show: false,
      reason: "missing_freshness",
      traversalMs: undefined,
    })
  })

  test("drops invalid scopes", () => {
    expect(
      toastDisplayDecision({ message: "bad", variant: "info", scope: "global", emittedAt: 1_000, ttlMs: 5_000 }, 2_000),
    ).toEqual({ show: false, reason: "invalid_scope", traversalMs: 1_000 })
  })
})
