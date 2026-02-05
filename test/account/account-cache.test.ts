import { describe, expect, test } from "bun:test"
import path from "path"
import { Account } from "../../src/account"
import { Global } from "../../src/global"

describe("account cache", () => {
  test("reloads when accounts.json changes", async () => {
    const file = path.join(Global.Path.data, "accounts.json")
    const one = {
      version: 2,
      families: {
        antigravity: {
          activeAccount: "antigravity-subscription-a",
          accounts: {
            "antigravity-subscription-a": {
              type: "subscription",
              name: "a",
              refreshToken: "rt-a",
              addedAt: Date.now(),
            },
          },
        },
      },
    }

    await Bun.write(file, JSON.stringify(one))
    const first = await Account.list("antigravity")
    expect(Object.keys(first)).toHaveLength(1)

    await Bun.sleep(5)
    const two = {
      version: 2,
      families: {
        antigravity: {
          activeAccount: "antigravity-subscription-a",
          accounts: {
            "antigravity-subscription-a": {
              type: "subscription",
              name: "a",
              refreshToken: "rt-a",
              addedAt: Date.now(),
            },
            "antigravity-subscription-b": {
              type: "subscription",
              name: "b",
              refreshToken: "rt-b",
              addedAt: Date.now(),
            },
          },
        },
      },
    }

    await Bun.write(file, JSON.stringify(two))
    const second = await Account.list("antigravity")
    expect(Object.keys(second)).toHaveLength(2)
  })
})
