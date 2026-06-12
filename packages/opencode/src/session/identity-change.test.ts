import { describe, expect, it } from "bun:test"
import { detectIdentityChange } from "./identity-change"

describe("detectIdentityChange", () => {
  it("fresh session → none", () => {
    const d = detectIdentityChange(undefined, { providerId: "codex" })
    expect(d).toEqual({ kind: "none", reason: "fresh-session" })
  })

  it("prior without providerId → none", () => {
    const d = detectIdentityChange({ accountId: "a" }, { providerId: "codex" })
    expect(d).toEqual({ kind: "none", reason: "no-prior-provider" })
  })

  it("provider differs → provider switch", () => {
    const d = detectIdentityChange({ providerId: "claude-cli" }, { providerId: "codex" })
    expect(d).toEqual({ kind: "provider", reason: "provider-changed" })
  })

  it("import anchor suppresses provider switch", () => {
    const d = detectIdentityChange({ providerId: "claude-cli", isImport: true }, { providerId: "codex" })
    expect(d).toEqual({ kind: "none", reason: "import-suppressed" })
  })

  it("same provider + same account → none", () => {
    const d = detectIdentityChange(
      { providerId: "codex", accountId: "a" },
      { providerId: "codex", accountId: "a" },
    )
    expect(d).toEqual({ kind: "none", reason: "same-account" })
  })

  it("same provider + different account → account switch", () => {
    const d = detectIdentityChange(
      { providerId: "codex", accountId: "a" },
      { providerId: "codex", accountId: "b" },
    )
    expect(d).toEqual({ kind: "account", reason: "account-changed" })
  })

  it("absent prior account → none (no phantom switch — 2026-05-26 RCA)", () => {
    const d = detectIdentityChange({ providerId: "codex" }, { providerId: "codex", accountId: "b" })
    expect(d).toEqual({ kind: "none", reason: "skip-absent-prior-account" })
  })

  it("absent incoming account → none (no phantom switch — 2026-05-26 RCA)", () => {
    const d = detectIdentityChange({ providerId: "codex", accountId: "a" }, { providerId: "codex" })
    expect(d).toEqual({ kind: "none", reason: "skip-absent-incoming-account" })
  })

  // ── issue_20260612: provider-switch compaction loop ──
  describe("anchor-already-rebased (provider-switch loop guard)", () => {
    it("suppresses re-switch when head anchor already carries the incoming provider", () => {
      // prior finished turn is still the pre-switch claude-cli turn (anchors
      // carry no `finish`), but a provider-switch compaction already wrote a
      // codex-stamped anchor. Without this guard the next prompt re-detects
      // claude-cli→codex and re-compacts forever.
      const d = detectIdentityChange(
        { providerId: "claude-cli", accountId: "cc", anchorProviderId: "codex" },
        { providerId: "codex", accountId: "cx" },
      )
      expect(d).toEqual({ kind: "none", reason: "anchor-already-rebased" })
    })

    it("still switches when the head anchor is a DIFFERENT provider than incoming", () => {
      // anchor is codex, but the user is now switching to gemini — that IS a
      // genuine new switch and must not be suppressed.
      const d = detectIdentityChange(
        { providerId: "claude-cli", accountId: "cc", anchorProviderId: "codex" },
        { providerId: "gemini", accountId: "gm" },
      )
      expect(d).toEqual({ kind: "provider", reason: "provider-changed" })
    })

    it("import suppression takes precedence over anchor-already-rebased", () => {
      const d = detectIdentityChange(
        { providerId: "claude-cli", isImport: true, anchorProviderId: "gemini" },
        { providerId: "codex" },
      )
      expect(d).toEqual({ kind: "none", reason: "import-suppressed" })
    })

    it("anchorProviderId does not affect the account dimension (same provider)", () => {
      // anchorProviderId is provider-dimension only; an account change under the
      // same provider must still be detected (codex cache-key RCA).
      const d = detectIdentityChange(
        { providerId: "codex", accountId: "a", anchorProviderId: "codex" },
        { providerId: "codex", accountId: "b" },
      )
      expect(d).toEqual({ kind: "account", reason: "account-changed" })
    })
  })
})
