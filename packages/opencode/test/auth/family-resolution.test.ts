import { describe, expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Auth } from "../../src/auth"
import { Account } from "../../src/account"

describe("auth family resolution", () => {
  test("maps models.dev provider instances to canonical family", async () => {
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
        await Auth.set("nvidia-work", {
          type: "api",
          key: "nv-key",
        })

        const canonical = await Account.list("nvidia")
        const legacy = await Account.list("nvidia-work")

        expect(Object.keys(canonical)).toHaveLength(1)
        expect(Object.keys(legacy)).toHaveLength(0)

        const [accountId] = Object.keys(canonical)
        expect(accountId.startsWith("nvidia-api-")).toBeTrue()

        const auth = await Auth.get("nvidia-work")
        expect(auth?.type).toBe("api")
        if (auth?.type === "api") {
          expect(auth.key).toBe("nv-key")
        }
      },
    })
  })

  test("keeps unknown providers explicit instead of fuzzy collapsing", async () => {
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
        await Auth.set("custom-provider-work", {
          type: "api",
          key: "custom-key",
        })

        const custom = await Account.list("custom-provider-work")
        expect(Object.keys(custom)).toHaveLength(1)

        const wrongCollapsed = await Account.list("custom")
        expect(Object.keys(wrongCollapsed)).toHaveLength(0)
      },
    })
  })
})
