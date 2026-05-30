import { describe, expect, test } from "bun:test"
import { Account } from "../../src/account"
import { Instance } from "../../src/project/instance"

// Offline regression guard for the claude-cli token-refresh persist fix
// (spec auth/credential-token-refresh-ineffective).
//
// Root cause being guarded: getModel persisted the rotated refresh token via
// the CLAUDE-side accountId / literal "claude-cli" instead of the opencode
// storage account id, so the rotated token never landed on the live account →
// next boot replayed a consumed token → invalid_grant → forced re-login. The
// fix resolves the real storage id (Account.findByRefreshToken) and updates it
// in place. These tests exercise that account-layer contract with NO network,
// NO live token, NO HTTP — so they can gate a merge without churning real
// credentials (which is what broke the live login during development).

function withStorage<T>(fn: () => Promise<T> | T): Promise<T> {
  return Instance.provide(async () => fn())
}

const sub = (over: Record<string, any>) => ({
  type: "subscription" as const,
  name: "test",
  refreshToken: "rt_base",
  accessToken: "at_old",
  expiresAt: 1,
  addedAt: 1,
  ...over,
})

describe("claude-cli token persist — findByRefreshToken + in-place update", () => {
  test("resolves storage id by base refresh token", () =>
    withStorage(async () => {
      const id = "claude-cli-subscription-claude-cli-aaaa"
      await Account.add("claude-cli", id, sub({ refreshToken: "rt_alpha", email: "a@x.com" }) as any)

      const found = await Account.findByRefreshToken("claude-cli", "rt_alpha")
      expect(found).toBe(id)
    }))

  test("matches on base token even when stored token carries a |projectId suffix", () =>
    withStorage(async () => {
      const id = "claude-cli-subscription-claude-cli-bbbb"
      await Account.add("claude-cli", id, sub({ refreshToken: "rt_beta|proj_123" }) as any)

      // The plugin looks up using the bare refresh token it was loaded with.
      const found = await Account.findByRefreshToken("claude-cli", "rt_beta")
      expect(found).toBe(id)
    }))

  test("returns undefined when no subscription account matches (NO-OP, never creates)", () =>
    withStorage(async () => {
      await Account.add("claude-cli", "claude-cli-subscription-claude-cli-cccc", sub({ refreshToken: "rt_gamma" }) as any)

      const found = await Account.findByRefreshToken("claude-cli", "rt_does_not_exist")
      expect(found).toBeUndefined()
    }))

  test("persist flow: lookup by PRE-rotation token then update in place — no duplicate, token rotated", () =>
    withStorage(async () => {
      const id = "claude-cli-subscription-claude-cli-dddd"
      await Account.add(
        "claude-cli",
        id,
        sub({ refreshToken: "rt_pre", accessToken: "at_pre", expiresAt: 100, email: "user@x.com", name: "user@x.com" }) as any,
      )

      // Simulate getModel persist: refresh rotated rt_pre → rt_post; we locate the
      // account by the pre-rotation token, then write the new token onto it.
      const storageId = await Account.findByRefreshToken("claude-cli", "rt_pre")
      expect(storageId).toBe(id)

      await Account.update("claude-cli", storageId!, {
        accessToken: "at_post",
        expiresAt: 200,
        refreshToken: "rt_post",
      })

      const accounts = await Account.list("claude-cli")
      // Invariant 1: exactly one account — the fix must never mint a duplicate.
      expect(Object.keys(accounts).length).toBe(1)
      // Invariant 2: same storage id, identity preserved.
      const updated = accounts[id] as any
      expect(updated).toBeTruthy()
      expect(updated.name).toBe("user@x.com")
      expect(updated.email).toBe("user@x.com")
      // Invariant 3: rotated token actually landed.
      expect(updated.refreshToken).toBe("rt_post")
      expect(updated.accessToken).toBe("at_post")
      expect(updated.expiresAt).toBe(200)
    }))

  test("API accounts are ignored by findByRefreshToken (subscription-only)", () =>
    withStorage(async () => {
      await Account.add("claude-cli", "claude-cli-api-key1", {
        type: "api",
        name: "apikey",
        apiKey: "rt_collide",
        addedAt: 1,
      } as any)

      const found = await Account.findByRefreshToken("claude-cli", "rt_collide")
      expect(found).toBeUndefined()
    }))
})
