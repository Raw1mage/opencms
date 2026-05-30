/**
 * error-classifier-token-refresh.test.ts
 *
 * Phase 4 (V4-1 / AC-1) regression tests for spec
 * `auth_credential-token-refresh-ineffective`, Requirement A (R-A0).
 *
 * Root cause guarded here: a claude-cli token-endpoint 429 (a *refresh* throttle,
 * needsReauth=false) must NOT be string-matched into an auth hard-stop. The
 * fix reshapes such transient errors into a rate-limit-shaped error whose
 * message intentionally OMITS the substring "token refresh failed" and carries
 * status:429, so:
 *   - isAuthError()       → false  (must not force re-login)
 *   - isRateLimitError()  → true   (route to RateLimitJudge → cooldown + rotate)
 *
 * Conversely a genuine invalid_grant / 401 / 403 (needsReauth=true) must still
 * be classified as an auth error so the dead grant triggers re-auth.
 *
 * These are pure-function tests (no IO, no rotation-state file writes), so they
 * are safe to run against the local ~/.config/opencode without polluting state
 * (per opencms AGENTS.md test-hygiene rule).
 *
 * Evidence: packages/opencode/src/account/rotation/error-classifier.ts
 *   isRateLimitError():42  early-returns false on "token refresh failed"
 *   isRateLimitError():52  returns true on status===429
 *   isAuthError():107      returns true on status 401/403
 *   isAuthError():120-123  returns true on auth message substrings
 */
import { describe, expect, test } from "bun:test"
import { isAuthError, isRateLimitError } from "../../src/account/rotation/error-classifier"

/**
 * reshapedTransientRefresh429 — the exact error shape the claude-cli getModel
 * layer throws after a transient (needsReauth=false / 429) refresh failure.
 * Mirrors packages/opencode/src/plugin/claude-cli/index.ts: the message says
 * "rate limited" and carries status 429, and deliberately does NOT contain the
 * substring "token refresh failed".
 */
function reshapedTransientRefresh429(status = 429): Error & { status: number } {
  return Object.assign(
    new Error(`claude-cli token endpoint rate limited (${status}); rotating to an available account`),
    { status },
  )
}

describe("error-classifier — token-refresh 429 reshape (R-A0 / AC-1)", () => {
  test("TV-A0/TV-A3: reshaped transient 429 is NOT an auth error (no forced re-login)", () => {
    const err = reshapedTransientRefresh429()
    expect(isAuthError(err)).toBe(false)
  })

  test("TV-A0: reshaped transient 429 IS a rate-limit error (routes to rotation)", () => {
    const err = reshapedTransientRefresh429()
    expect(isRateLimitError(err)).toBe(true)
  })

  test("TV-A3 regression guard: a message still containing 'token refresh failed' is auth, not rate-limit", () => {
    // This is the PRE-fix shape. If the reshape ever regresses to leaving the
    // raw provider message intact, isAuthError would catch it (hard-stop) and
    // isRateLimitError would early-return false — exactly the bug. Assert the
    // classifier's documented precedence so the reshape's value is locked in.
    const raw = Object.assign(new Error("Token refresh failed (429): too many requests"), { status: 429 })
    expect(isAuthError(raw)).toBe(true)
    expect(isRateLimitError(raw)).toBe(false)
  })

  test("TV-A2: invalid_grant / 401 stays an auth error (genuine re-auth)", () => {
    const invalidGrant = Object.assign(
      new Error("Anthropic API error 400: invalid_grant — Refresh token not found or invalid"),
      { status: 400 },
    )
    // 400 alone is not auth by status; but a true dead-grant path in this repo
    // surfaces as 401/403 to the host. Assert the 401 path explicitly:
    const unauthorized = Object.assign(new Error("unauthorized"), { status: 401 })
    expect(isAuthError(unauthorized)).toBe(true)
    expect(isRateLimitError(unauthorized)).toBe(false)
    // 400 invalid_grant is not matched by the generic classifier (handled by the
    // provider's needsReauth flag upstream, not the string classifier) — document that:
    expect(isAuthError(invalidGrant)).toBe(false)
  })

  test("TV-A2: 403 forbidden is an auth error", () => {
    const forbidden = Object.assign(new Error("forbidden"), { status: 403 })
    expect(isAuthError(forbidden)).toBe(true)
  })

  test("plain inference 429 (not a refresh) routes to rate-limit, not auth", () => {
    const inference429 = Object.assign(new Error("429 Too Many Requests"), { status: 429 })
    expect(isRateLimitError(inference429)).toBe(true)
    expect(isAuthError(inference429)).toBe(false)
  })

  test("null / undefined / non-object inputs are neither", () => {
    for (const bad of [null, undefined, 42, "string"]) {
      expect(isAuthError(bad)).toBe(false)
      expect(isRateLimitError(bad)).toBe(false)
    }
  })
})
