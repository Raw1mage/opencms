import { describe, expect, test } from "bun:test"
import path from "path"
import { Account } from "../../src/account"
import { Global } from "../../src/global"

// Regression for BR 2026-06-14: deleting the last account in a family left
// `activeAccount: null` in accounts.json. `z.string().optional()` rejects null,
// so Storage.safeParse failed and load() reset the ENTIRE file to empty — every
// provider's accounts disappeared from the UI even though they were still on
// disk. load() now strips null activeAccount pointers before validating, so one
// dirty pointer can no longer nuke all accounts.
describe("accounts.json null activeAccount resilience", () => {
  test("a stray null activeAccount does not wipe other providers' accounts", async () => {
    const file = path.join(Global.Path.user, "accounts.json")
    await Bun.write(
      file,
      JSON.stringify({
        version: 2,
        families: {
          // The emptied family that the delete left behind with a null pointer.
          google: { activeAccount: null, accounts: {} },
          // A real, untouched provider that must survive the load.
          codex: {
            activeAccount: "codex-subscription-a",
            accounts: {
              "codex-subscription-a": {
                type: "subscription",
                name: "a",
                refreshToken: "rt-a",
                addedAt: Date.now(),
              },
            },
          },
        },
      }),
    )
    await Account.refresh()

    // Before the fix this returned {} because the whole file was rejected and
    // reset to empty. The real provider must survive the stray null.
    const codex = await Account.list("codex")
    expect(Object.keys(codex)).toHaveLength(1)
    expect(codex["codex-subscription-a"]?.name).toBe("a")

    // The emptied family loads cleanly as empty (no active pointer), not as a
    // parse failure.
    const google = await Account.list("google")
    expect(Object.keys(google)).toHaveLength(0)
    expect(await Account.getActive("google")).toBeUndefined()
  })
})
