import { describe, expect, test } from "bun:test"
import path from "path"
import { Account } from "../../src/account"
import { Global } from "../../src/global"

// Offline regression guard for the claude-cli token-refresh persist fix
// (spec auth/credential-token-refresh-ineffective).
//
// Root cause being guarded: getModel persisted the rotated refresh token by the
// CLAUDE-side accountId / literal "claude-cli" instead of the opencode storage
// account id, so the rotated token never landed on the live account → next boot
// replayed a consumed token → invalid_grant → forced re-login. The fix resolves
// the real storage id via Account.findByRefreshToken (base-token match) and
// updates it in place. These tests exercise that resolver with NO network, NO
// live token, NO HTTP — so they gate a merge without churning real credentials
// (which is what broke the live login during development).
//
// Storage is seeded by writing accounts.json directly + Account.refresh(),
// mirroring account-cache.test.ts (the working pattern). We deliberately avoid
// Account.add / Instance.provide, which pull in project-instance context that
// isn't set up in this unit harness.

const accountsFile = () => path.join(Global.Path.user, "accounts.json")

function seed(accounts: Record<string, any>): Promise<void> {
  const doc = {
    version: 2,
    families: {
      "claude-cli": {
        activeAccount: Object.keys(accounts)[0],
        accounts,
      },
    },
  }
  return Bun.write(accountsFile(), JSON.stringify(doc)).then(() => Account.refresh())
}

const sub = (over: Record<string, any>) => ({
  type: "subscription",
  name: "test",
  refreshToken: "rt_base",
  accessToken: "at_old",
  expiresAt: 1,
  addedAt: 1,
  ...over,
})

describe("claude-cli Account.findByRefreshToken (token-persist storage-id resolver)", () => {
  test("resolves storage id by base refresh token", async () => {
    const id = "claude-cli-subscription-claude-cli-aaaa"
    await seed({ [id]: sub({ refreshToken: "rt_alpha", email: "a@x.com", name: "a@x.com" }) })
    expect(await Account.findByRefreshToken("claude-cli", "rt_alpha")).toBe(id)
  })

  test("matches on base token even when stored token carries a |projectId suffix", async () => {
    const id = "claude-cli-subscription-claude-cli-bbbb"
    await seed({ [id]: sub({ refreshToken: "rt_beta|proj_123" }) })
    // The plugin looks up using the bare refresh token it was loaded with.
    expect(await Account.findByRefreshToken("claude-cli", "rt_beta")).toBe(id)
  })

  test("returns undefined when no subscription account matches (NO-OP, never creates)", async () => {
    await seed({ "claude-cli-subscription-claude-cli-cccc": sub({ refreshToken: "rt_gamma" }) })
    expect(await Account.findByRefreshToken("claude-cli", "rt_does_not_exist")).toBeUndefined()
  })

  test("picks the right account among several by its base token", async () => {
    await seed({
      "claude-cli-subscription-claude-cli-one": sub({ refreshToken: "rt_one", email: "one@x.com" }),
      "claude-cli-subscription-claude-cli-two": sub({ refreshToken: "rt_two|proj", email: "two@x.com" }),
      "claude-cli-subscription-claude-cli-three": sub({ refreshToken: "rt_three", email: "three@x.com" }),
    })
    expect(await Account.findByRefreshToken("claude-cli", "rt_two")).toBe("claude-cli-subscription-claude-cli-two")
    expect(await Account.findByRefreshToken("claude-cli", "rt_three")).toBe("claude-cli-subscription-claude-cli-three")
  })

  test("API accounts are ignored (subscription-only)", async () => {
    await seed({
      "claude-cli-api-key1": { type: "api", name: "apikey", apiKey: "rt_collide", addedAt: 1 },
    })
    expect(await Account.findByRefreshToken("claude-cli", "rt_collide")).toBeUndefined()
  })
})
