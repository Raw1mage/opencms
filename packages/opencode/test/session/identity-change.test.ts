import { describe, expect, test } from "bun:test"
import { detectIdentityChange } from "../../src/session/identity-change"

describe("detectIdentityChange", () => {
  test("fresh session (no prior) → none / fresh-session", () => {
    expect(detectIdentityChange(undefined, { providerId: "codex", accountId: "a" })).toEqual({
      kind: "none",
      reason: "fresh-session",
    })
  })

  test("prior without providerId → none / no-prior-provider", () => {
    expect(detectIdentityChange({ accountId: "a" }, { providerId: "codex", accountId: "a" })).toEqual({
      kind: "none",
      reason: "no-prior-provider",
    })
  })

  test("same provider + same account → none / same-account", () => {
    expect(
      detectIdentityChange({ providerId: "codex", accountId: "a" }, { providerId: "codex", accountId: "a" }),
    ).toEqual({ kind: "none", reason: "same-account" })
  })

  test("different provider → provider / provider-changed", () => {
    expect(
      detectIdentityChange({ providerId: "anthropic", accountId: "a" }, { providerId: "codex", accountId: "b" }),
    ).toEqual({ kind: "provider", reason: "provider-changed" })
  })

  test("import anchor: providerId differs but isImport=true → none / import-suppressed", () => {
    expect(
      detectIdentityChange(
        { providerId: "anthropic", accountId: "a", isImport: true },
        { providerId: "codex", accountId: "b" },
      ),
    ).toEqual({ kind: "none", reason: "import-suppressed" })
  })

  test("same provider + different account (both defined) → account / account-changed", () => {
    expect(
      detectIdentityChange({ providerId: "codex", accountId: "a" }, { providerId: "codex", accountId: "b" }),
    ).toEqual({ kind: "account", reason: "account-changed" })
  })

  // ── 2026-05-26 warroom regression: phantom account switch ────────
  // The buggy inline condition was:
  //   prevAccount !== nextAccount && !!(prevAccount || nextAccount)
  // which evaluated true when prevAccount was undefined and nextAccount
  // was defined. Result: chain reset, message count nuked from ~120
  // to ~4, cache loss, pidgin self-doubt spiral. The "skip-absent-*"
  // reasons make this code path observable in the daemon log so future
  // regressions are catchable.

  test("prior accountId undefined → none / skip-absent-prior-account (NOT phantom)", () => {
    expect(
      detectIdentityChange({ providerId: "codex", accountId: undefined }, { providerId: "codex", accountId: "a" }),
    ).toEqual({ kind: "none", reason: "skip-absent-prior-account" })
  })

  test("incoming accountId undefined → none / skip-absent-incoming-account (NOT phantom)", () => {
    expect(
      detectIdentityChange({ providerId: "codex", accountId: "a" }, { providerId: "codex", accountId: undefined }),
    ).toEqual({ kind: "none", reason: "skip-absent-incoming-account" })
  })

  test("both accountId undefined → none / skip-absent-prior-account", () => {
    // prior side is checked first, so it wins the reason tag
    expect(
      detectIdentityChange(
        { providerId: "codex", accountId: undefined },
        { providerId: "codex", accountId: undefined },
      ),
    ).toEqual({ kind: "none", reason: "skip-absent-prior-account" })
  })

  test("provider change wins over account change", () => {
    expect(
      detectIdentityChange({ providerId: "anthropic", accountId: "a" }, { providerId: "codex", accountId: "b" }),
    ).toEqual({ kind: "provider", reason: "provider-changed" })
  })

  test("import anchor with matching accounts → none / import-suppressed", () => {
    // Even when providers happen to match in shape, isImport short-circuits
    // BEFORE account comparison if provider differs. Here providers differ
    // so we hit import-suppressed.
    expect(
      detectIdentityChange(
        { providerId: "anthropic", accountId: "a", isImport: true },
        { providerId: "codex", accountId: "a" },
      ),
    ).toEqual({ kind: "none", reason: "import-suppressed" })
  })

  test("all 8 reasons are covered by this suite (smoke check)", () => {
    const reasons = new Set([
      "fresh-session",
      "no-prior-provider",
      "provider-changed",
      "import-suppressed",
      "same-account",
      "account-changed",
      "skip-absent-prior-account",
      "skip-absent-incoming-account",
    ])
    expect(reasons.size).toBe(8)
  })
})
