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

// @plans/provider-hotfix Phase 4 — disabled_providers is now an auto-gate.
// When the operator lists <id> in disabled_providers AND has config.provider.<id>
// (or OAuth accounts for it), the explicit path (getModel) must still resolve.
// Prior behavior deleted the provider from the dict at post-processing, which
// silently blocked the operator's own pinned requests.
test("explicit getModel resolves even when provider is in disabled_providers", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      // config.provider.openai causes openai to be merged into the providers
      // dict via the configProviders loop (which does NOT check disabled,
      // unlike the env/auth/plugin auto-load loops).
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          disabled_providers: ["openai"],
          provider: {
            openai: {
              options: { apiKey: "openai-hotfix-key" },
            },
          },
        }),
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      // Provider state is cached globally across tests; reset so our
      // disabled_providers override is actually honored on rebuild.
      Provider.reset()

      // Provider.list() filters auto-hidden providers (TUI / catalog view).
      const visible = await Provider.list()
      expect(visible["openai"]).toBeUndefined()

      // listAllIncludingHidden() returns the full set for admin / explicit flows.
      const full = await Provider.listAllIncludingHidden()
      expect(full["openai"]).toBeDefined()
      const modelIDs = Object.keys(full["openai"].models)
      expect(modelIDs.length).toBeGreaterThan(0)
      const firstModelID = modelIDs[0]

      // Explicit getModel resolves — operator rescue path when they have
      // accounts but kept the provider in disabled_providers.
      const model = await Provider.getModel("openai", firstModelID)
      expect(model.id).toBe(firstModelID)
      expect(model.providerId).toBe("openai")
    },
  })
})

test("cms admin-like nvidia api account shows provider model list", async () => {
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
      const { Account } = await import("../../src/account")

      const accountId = Account.generateId("nvidia", "api", "work")
      await Account.add("nvidia", accountId, {
        type: "api",
        name: "work",
        apiKey: "nvidia-test-key",
        addedAt: Date.now(),
      })
      await Account.setActive("nvidia", accountId)

      const providers = await Provider.list()
      const familyProvider = providers["nvidia"]
      const accountProvider = providers[accountId]

      expect(familyProvider).toBeDefined()
      expect(Object.keys(familyProvider.models).length).toBeGreaterThan(0)
      // Account-specific provider entries are optional; admin model list can resolve by family fallback.
      if (accountProvider) {
        expect(Object.keys(accountProvider.models).length).toBeGreaterThan(0)
      }

      const firstModelID = Object.keys((accountProvider ?? familyProvider).models)[0]
      expect(firstModelID).toBeDefined()
      const model = await Provider.getModel(accountProvider ? accountId : "nvidia", firstModelID)
      expect(model.id).toBe(firstModelID)
      expect(model.providerId).toBe(accountProvider ? accountId : "nvidia")
    },
  })
})
