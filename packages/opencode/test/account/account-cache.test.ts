import { describe, expect, test } from "bun:test"
import path from "path"
import { Account } from "../../src/account"
import { Global } from "../../src/global"

describe("account cache", () => {
  test("reloads when accounts.json changes", async () => {
    const file = path.join(Global.Path.user, "accounts.json")
    const one = {
      version: 2,
      families: {
        openai: {
          activeAccount: "openai-subscription-a",
          accounts: {
            "openai-subscription-a": {
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
    const first = await Account.list("openai")
    expect(Object.keys(first)).toHaveLength(1)

    await Bun.sleep(5)
    const two = {
      version: 2,
      families: {
        openai: {
          activeAccount: "openai-subscription-a",
          accounts: {
            "openai-subscription-a": {
              type: "subscription",
              name: "a",
              refreshToken: "rt-a",
              addedAt: Date.now(),
            },
            "openai-subscription-b": {
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
    await Account.refresh()
    const second = await Account.list("openai")
    expect(Object.keys(second)).toHaveLength(2)
  })
})
