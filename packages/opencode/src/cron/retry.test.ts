import { describe, expect, it } from "bun:test"
import { RetryPolicy } from "./retry"
import type { CronRunOutcome, CronSchedule } from "./types"

describe("RetryPolicy", () => {
  // --- Error classification ---

  describe("classifyError", () => {
    it("classifies rate limit as transient", () => {
      expect(RetryPolicy.classifyError("429 Too Many Requests")).toBe("transient")
      expect(RetryPolicy.classifyError("rate_limit exceeded")).toBe("transient")
    })

    it("classifies overloaded as transient", () => {
      expect(RetryPolicy.classifyError("529 overloaded")).toBe("transient")
      expect(RetryPolicy.classifyError("high demand, try later")).toBe("transient")
    })

    it("classifies network errors as transient", () => {
      expect(RetryPolicy.classifyError("ECONNRESET")).toBe("transient")
      expect(RetryPolicy.classifyError("fetch failed")).toBe("transient")
    })

    it("classifies timeout as transient", () => {
      expect(RetryPolicy.classifyError("ETIMEDOUT")).toBe("transient")
      expect(RetryPolicy.classifyError("request timeout")).toBe("transient")
    })

    it("classifies server errors as transient", () => {
      expect(RetryPolicy.classifyError("502 Bad Gateway")).toBe("transient")
      expect(RetryPolicy.classifyError("503 Service Unavailable")).toBe("transient")
    })

    it("classifies unknown errors as permanent", () => {
      expect(RetryPolicy.classifyError("invalid API key")).toBe("permanent")
      expect(RetryPolicy.classifyError(undefined)).toBe("permanent")
    })

    it("respects explicit permanent reasons", () => {
      expect(RetryPolicy.classifyError("some error", "auth_permanent")).toBe("permanent")
      expect(RetryPolicy.classifyError("some error", "billing")).toBe("permanent")
      expect(RetryPolicy.classifyError("some error", "model_not_found")).toBe("permanent")
    })
  })

  // --- Backoff schedule ---

  describe("backoffMs", () => {
    it("returns escalating delays", () => {
      expect(RetryPolicy.backoffMs(1)).toBe(30_000)
      expect(RetryPolicy.backoffMs(2)).toBe(60_000)
      expect(RetryPolicy.backoffMs(3)).toBe(300_000)
      expect(RetryPolicy.backoffMs(4)).toBe(900_000)
      expect(RetryPolicy.backoffMs(5)).toBe(3_600_000)
    })

    it("caps at max backoff for high error counts", () => {
      expect(RetryPolicy.backoffMs(10)).toBe(3_600_000)
      expect(RetryPolicy.backoffMs(100)).toBe(3_600_000)
    })

    it("supports custom schedule", () => {
      expect(RetryPolicy.backoffMs(1, [1000, 2000])).toBe(1000)
      expect(RetryPolicy.backoffMs(2, [1000, 2000])).toBe(2000)
      expect(RetryPolicy.backoffMs(5, [1000, 2000])).toBe(2000)
    })
  })

  // --- decide() ---

  const everySchedule: CronSchedule = { kind: "every", everyMs: 1800_000 } // 30min
  const atSchedule: CronSchedule = { kind: "at", at: "2026-12-31T00:00:00Z" }
  const now = 1710000000000

  describe("decide — success", () => {
    it("resets errors and computes next run for recurring", () => {
      const result = RetryPolicy.decide(
        { schedule: everySchedule },
        { consecutiveErrors: 3 },
        { status: "ok", durationMs: 100 },
        undefined,
        now,
      )
      expect(result.action).toBe("continue")
      expect(result.consecutiveErrors).toBe(0)
      if (result.action === "continue") {
        expect(result.nextRunAtMs).toBeGreaterThan(now)
      }
    })

    it("disables one-shot on success", () => {
      const result = RetryPolicy.decide(
        { schedule: atSchedule },
        { consecutiveErrors: 0 },
        { status: "ok" },
        undefined,
        now,
      )
      expect(result.action).toBe("disable")
      expect(result.consecutiveErrors).toBe(0)
    })

    it("handles skipped as success", () => {
      const result = RetryPolicy.decide(
        { schedule: everySchedule },
        { consecutiveErrors: 2 },
        { status: "skipped" },
        undefined,
        now,
      )
      expect(result.consecutiveErrors).toBe(0)
    })
  })

  describe("decide — permanent error", () => {
    it("disables immediately", () => {
      const result = RetryPolicy.decide(
        { schedule: everySchedule },
        { consecutiveErrors: 0 },
        { status: "error", error: "invalid API key" },
        undefined,
        now,
      )
      expect(result.action).toBe("disable")
      expect(result.consecutiveErrors).toBe(1)
    })
  })

  describe("decide — transient error, one-shot", () => {
    it("retries with backoff", () => {
      const result = RetryPolicy.decide(
        { schedule: atSchedule },
        { consecutiveErrors: 0 },
        { status: "error", error: "429 rate limit" },
        undefined,
        now,
      )
      expect(result.action).toBe("continue")
      expect(result.consecutiveErrors).toBe(1)
      if (result.action === "continue") {
        expect(result.nextRunAtMs).toBe(now + 30_000)
      }
    })

    it("disables after max attempts", () => {
      const result = RetryPolicy.decide(
        { schedule: atSchedule },
        { consecutiveErrors: 2 },
        { status: "error", error: "429 rate limit" },
        { maxAttempts: 3 },
        now,
      )
      expect(result.action).toBe("disable")
      expect(result.consecutiveErrors).toBe(3)
    })
  })

  describe("decide — transient error, recurring", () => {
    it("overlays backoff on natural schedule", () => {
      const result = RetryPolicy.decide(
        { schedule: everySchedule },
        { consecutiveErrors: 0 },
        { status: "error", error: "503 unavailable" },
        undefined,
        now,
      )
      expect(result.action).toBe("continue")
      expect(result.consecutiveErrors).toBe(1)
      if (result.action === "continue") {
        // Should be max(natural, backoff) — backoff 30s is less than 30min natural interval
        expect(result.nextRunAtMs).toBe(now + 1800_000)
      }
    })

    it("uses backoff when longer than natural interval", () => {
      // Short interval (1 min) with 4th error (15 min backoff)
      const shortSchedule: CronSchedule = { kind: "every", everyMs: 60_000 }
      const result = RetryPolicy.decide(
        { schedule: shortSchedule },
        { consecutiveErrors: 3 },
        { status: "error", error: "ECONNRESET" },
        undefined,
        now,
      )
      expect(result.action).toBe("continue")
      if (result.action === "continue") {
        // 4th error → 15min backoff > 1min natural → use backoff
        expect(result.nextRunAtMs).toBe(now + 900_000)
      }
    })
  })

  // --- applyOutcomeToState ---

  describe("applyOutcomeToState", () => {
    it("produces correct state fields on success", () => {
      const decision: RetryPolicy.RetryDecision = {
        action: "continue",
        nextRunAtMs: now + 1800_000,
        consecutiveErrors: 0,
      }
      const state = RetryPolicy.applyOutcomeToState(
        { status: "ok", durationMs: 500 },
        decision,
        now,
      )
      expect(state.lastRunStatus).toBe("ok")
      expect(state.consecutiveErrors).toBe(0)
      expect(state.lastError).toBeUndefined()
      expect(state.lastErrorReason).toBeUndefined()
      expect(state.nextRunAtMs).toBe(now + 1800_000)
      expect(state.runningAtMs).toBeUndefined()
    })

    it("produces correct state fields on error with disable", () => {
      const decision: RetryPolicy.RetryDecision = {
        action: "disable",
        reason: "permanent error",
        consecutiveErrors: 1,
      }
      const state = RetryPolicy.applyOutcomeToState(
        { status: "error", error: "bad auth" },
        decision,
        now,
      )
      expect(state.lastRunStatus).toBe("error")
      expect(state.consecutiveErrors).toBe(1)
      expect(state.lastError).toBe("bad auth")
      expect(state.nextRunAtMs).toBeUndefined()
    })
  })
})
