import { test, expect, mock } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"

// Prevent real install side effects during provider bootstrap.
mock.module("../../src/bun/index", () => ({
  BunProc: {
    install: async (pkg: string, _version?: string) => {
      const lastAtIndex = pkg.lastIndexOf("@")
      return lastAtIndex > 0 ? pkg.substring(0, lastAtIndex) : pkg
    },
    run: async () => {
      throw new Error("BunProc.run should not be called in tests")
    },
    which: () => process.execPath,
    InstallFailedError: class extends Error {},
  },
}))

const mockPlugin = async () => ({})
mock.module("opencode-copilot-auth", () => ({ default: mockPlugin }))
mock.module("opencode-anthropic-auth", () => ({ default: mockPlugin }))
mock.module("@gitlab/opencode-gitlab-auth", () => ({ default: mockPlugin }))

test("cms provider baseline exposes core families", async () => {
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
      const providers = await Provider.list()
      const keys = Object.keys(providers)

      expect(keys).toContain("antigravity")
      expect(keys).toContain("gemini-cli")
      expect(keys).toContain("github-copilot")
      expect(keys).toContain("openai")
      expect(keys).toContain("google")

      // cms runtime removes legacy anthropic provider identity.
      expect(keys).not.toContain("anthropic")
    },
  })
})

test("cms config providers remain available even when disabled_providers lists a core id", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          disabled_providers: ["openai"],
        }),
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await Provider.list()
      // Current cms behavior: explicit config/provider merge can re-add a provider
      // after disabled_providers filtering.
      expect(providers["openai"]).toBeDefined()
      expect(providers["openai"].source).toBe("config")
      expect(providers["gemini-cli"]).toBeDefined()
    },
  })
})

test("cms provider list models can be resolved via getModel", async () => {
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
      const providers = await Provider.list()
      const openai = providers["openai"]
      expect(openai).toBeDefined()

      const firstModelID = Object.keys(openai.models)[0]
      expect(firstModelID).toBeDefined()

      const model = await Provider.getModel("openai", firstModelID)
      expect(model.id).toBe(firstModelID)
      expect(model.providerId).toBe("openai")
    },
  })
})
