import { describe, expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Global } from "../../src/global"
import { Account } from "../../src/account"

describe("account family normalization", () => {
  test("normalizes legacy instance-like family keys to canonical provider family", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const file = path.join(Global.Path.user, "accounts.json")
        await Bun.write(
          file,
          JSON.stringify({
            version: 2,
            families: {
              "nvidia-work": {
                activeAccount: "nvidia-work-api-work",
                accounts: {
                  "nvidia-work-api-work": {
                    type: "api",
                    name: "work",
                    apiKey: "nv-key",
                    addedAt: Date.now(),
                  },
                },
              },
            },
          }),
        )

        const report = await Account.normalizeIdentities()
        // Depending on read order, normalization may already happen during Account.load().
        // Ensure canonical family state instead of asserting on change timing.
        expect(report.familiesAfter.includes("nvidia")).toBeTrue()

        await Account.refresh()
        const all = await Account.listAll()

        expect(all["nvidia"]).toBeDefined()
        expect(all["nvidia-work"]).toBeUndefined()
        expect(Object.keys(all["nvidia"].accounts)).toHaveLength(1)
      },
    })
  })
})
