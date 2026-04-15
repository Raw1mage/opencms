import { describe, expect, test } from "bun:test"
import {
  buildAccountRows,
  buildCustomProviderEntries,
  buildProviderRows,
  FREE_TO_USE_ACCOUNT_LABEL,
  filterModelsForMode,
  loadFavoriteProvidersFromStorage,
  loadHiddenProvidersFromStorage,
  normalizeProviderKey,
  parseHiddenProvidersStorageValue,
  pickSelectedAccount,
  pickSelectedModel,
  resolveAccountDisplayLabel,
  sameModelSelectorSelection,
  usesFreeToUseAccountLabel,
} from "./model-selector-state"

describe("model selector state", () => {
  test("provider rows are built from provider universe and account families", () => {
    const rows = buildProviderRows({
      providers: [
        { id: "openai-api-primary", name: "OpenAI Primary" },
        { id: "google-api", name: "Google API" },
      ],
      favoriteProviders: ["openai", "google-api"],
      accountFamilies: {
        "claude-cli": { accounts: { a1: {} } },
      },
    })

    expect(rows.some((row) => row.providerKey === "openai")).toBe(true)
    expect(rows.some((row) => row.providerKey === "claude-cli")).toBe(true)
    expect(rows.find((row) => row.providerKey === "google-api")?.enabled).toBe(true)
  })

  test("claude-cli row remains enabled", () => {
    const rows = buildProviderRows({
      providers: [{ id: "claude-cli", name: "Claude CLI" }],
      favoriteProviders: ["claude-cli"],
    })

    expect(rows.find((row) => row.providerKey === "claude-cli")?.enabled).toBe(true)
  })

  test("provider rows respect user-controlled favorite providers", () => {
    const rows = buildProviderRows({
      providers: [
        { id: "claude-cli", name: "Claude CLI" },
        { id: "openai", name: "OpenAI" },
      ],
      favoriteProviders: ["anthropic"],
    })

    expect(rows.find((row) => row.providerKey === "claude-cli")?.enabled).toBe(true)
    expect(rows.find((row) => row.providerKey === "openai")?.enabled).toBe(false)
  })

  test("custom provider entries normalize config models for model manager", () => {
    const rows = buildCustomProviderEntries({
      miat: {
        npm: "@ai-sdk/openai-compatible",
        name: "MIAT",
        models: {
          "qwen3.5:9b-128k": {
            name: "Qwen 3.5 9B 128K",
            limit: { context: 128000, output: 8192 },
          },
        },
      },
    })

    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe("miat")
    expect((rows[0]?.models as Record<string, { id?: string }>)?.["qwen3.5:9b-128k"]?.id).toBe("qwen3.5:9b-128k")
  })

  test("provider rows include custom providers from merged frontend provider surface", () => {
    const rows = buildProviderRows({
      providers: [
        { id: "openai", name: "OpenAI" },
        ...buildCustomProviderEntries({
          ollama: {
            npm: "@ai-sdk/openai-compatible",
            name: "Ollama",
            models: {
              llama3: { name: "Llama 3" },
            },
          },
        }),
      ],
    })

    expect(rows.find((row) => row.providerKey === "ollama")?.name).toBe("Ollama")
  })

  test("account rows keep stable label ordering and include cooldown reason", () => {
    const now = 1_000
    const rows = buildAccountRows({
      selectedProviderKey: "openai",
      now,
      formatCooldown: (minutes) => `cooldown ${minutes}m`,
      accountFamilies: {
        openai: {
          activeAccount: "acct2",
          accounts: {
            acct1: { name: "A", coolingDownUntil: now + 120_000 },
            acct2: { name: "B" },
          },
        },
      },
    })

    expect(rows.map((row) => row.id)).toEqual(["acct1", "acct2"])
    expect(rows.find((row) => row.id === "acct2")?.active).toBe(true)
    expect(rows.find((row) => row.id === "acct1")?.unavailable).toBe("cooldown 2m")
  })

  test("account row order stays stable when active account changes", () => {
    const accountFamilies = {
      openai: {
        activeAccount: "acct1",
        accounts: {
          acct2: { name: "Beta" },
          acct1: { name: "Alpha" },
        },
      },
    }

    const before = buildAccountRows({
      selectedProviderKey: "openai",
      accountFamilies,
      formatCooldown: (minutes) => `cooldown ${minutes}m`,
    })

    const after = buildAccountRows({
      selectedProviderKey: "openai",
      accountFamilies: {
        openai: {
          ...accountFamilies.openai,
          activeAccount: "acct2",
        },
      },
      formatCooldown: (minutes) => `cooldown ${minutes}m`,
    })

    expect(before.map((row) => row.id)).toEqual(["acct1", "acct2"])
    expect(after.map((row) => row.id)).toEqual(["acct1", "acct2"])
    expect(before.find((row) => row.id === "acct1")?.active).toBe(true)
    expect(after.find((row) => row.id === "acct2")?.active).toBe(true)
  })

  test("pickSelectedAccount preserves current selection across active-account changes", () => {
    const before = [
      { id: "acct1", active: true },
      { id: "acct2", active: false },
    ]
    const after = [
      { id: "acct1", active: false },
      { id: "acct2", active: true },
    ]

    expect(
      pickSelectedAccount({
        selectedAccountId: "acct1",
        accounts: before,
      }),
    ).toBe("acct1")

    expect(
      pickSelectedAccount({
        selectedAccountId: "acct1",
        accounts: after,
      }),
    ).toBe("acct1")
  })

  test("pickSelectedAccount falls back to active account when selection disappears", () => {
    expect(
      pickSelectedAccount({
        selectedAccountId: "acct-missing",
        accounts: [
          { id: "acct1", active: false },
          { id: "acct2", active: true },
        ],
      }),
    ).toBe("acct2")
  })

  test("pickSelectedAccount prefers session-scoped account before active account", () => {
    expect(
      pickSelectedAccount({
        selectedAccountId: "",
        preferredAccountId: "acct1",
        accounts: [
          { id: "acct1", active: false },
          { id: "acct2", active: true },
        ],
      }),
    ).toBe("acct1")
  })

  test("freeToUse flag enables FreeToUse label for no-account providers", () => {
    expect(
      usesFreeToUseAccountLabel({
        freeToUse: true,
        accounts: [],
        models: [{ id: "llama3", provider: { id: "ollama" } }],
      }),
    ).toBe(true)
    expect(
      resolveAccountDisplayLabel({
        usesFreeToUseLabel: true,
      }),
    ).toBe(FREE_TO_USE_ACCOUNT_LABEL)
  })

  test("no-account providers stay account-based until freeToUse flag is enabled", () => {
    expect(
      usesFreeToUseAccountLabel({
        freeToUse: false,
        accounts: [],
        models: [{ id: "llama3", provider: { id: "ollama" } }],
      }),
    ).toBe(false)
    expect(
      resolveAccountDisplayLabel({
        fallbackLabel: "No account data",
      }),
    ).toBe("No account data")
  })

  test("account display label keeps active account fallback for account-based providers", () => {
    expect(
      resolveAccountDisplayLabel({
        activeAccountId: "acct2",
      }),
    ).toBe("acct2")
  })

  test("favorites mode only keeps visible models in selected provider key", () => {
    const models = [
      { id: "m1", provider: { id: "openai-api-primary" } },
      { id: "m2", provider: { id: "openai-api-primary" } },
      { id: "m3", provider: { id: "google-api" } },
    ]

    const rows = filterModelsForMode({
      models,
      providerKey: "openai",
      mode: "favorites",
      isVisible: (key) => key.modelID === "m2",
    })

    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe("m2")
  })

  test("all mode keeps all models in selected provider key", () => {
    const models = [
      { id: "m1", provider: { id: "openai-api-primary" } },
      { id: "m2", provider: { id: "openai-api-primary" } },
      { id: "m3", provider: { id: "google-api" } },
    ]

    const rows = filterModelsForMode({
      models,
      providerKey: "openai",
      mode: "all",
      isVisible: () => false,
    })

    expect(rows.map((row) => row.id)).toEqual(["m1", "m2"])
  })

  test("hidden-provider storage loader reads localStorage-backed provider ids", () => {
    const storage = {
      getItem: (key: string) =>
        key === "opencode.web.modelManager.hiddenProviders.v1"
          ? JSON.stringify(["openai", "claude-cli", 123, null])
          : null,
    }

    expect(loadHiddenProvidersFromStorage(storage, "opencode.web.modelManager.hiddenProviders.v1")).toEqual([
      "openai",
      "claude-cli",
    ])
  })

  test("hidden-provider storage parser tolerates malformed persisted values", () => {
    expect(parseHiddenProvidersStorageValue("{bad json")).toEqual([])
    expect(parseHiddenProvidersStorageValue(JSON.stringify({ provider: "openai" }))).toEqual([])
  })

  test("favorite-provider storage loader falls back to popular providers only when missing", () => {
    const storage = {
      getItem: (key: string) =>
        key === "opencode.web.modelManager.favoriteProviders.v1" ? JSON.stringify(["miat", "openai"]) : null,
    }

    expect(
      loadFavoriteProvidersFromStorage(storage, "opencode.web.modelManager.favoriteProviders.v1", ["claude-cli"]),
    ).toEqual(["miat", "openai"])
    expect(loadFavoriteProvidersFromStorage(storage, "missing", ["claude-cli"])).toEqual(["claude-cli"])
  })

  test("pickSelectedModel preserves explicit draft selection when still visible", () => {
    const models = [
      { id: "gpt-5", provider: { id: "openai" } },
      { id: "gpt-5.4", provider: { id: "openai" } },
    ]

    const selected = pickSelectedModel({
      selected: { providerID: "openai", modelID: "gpt-5" },
      preferred: { providerID: "openai", modelID: "gpt-5.4" },
      models,
    })

    expect(selected?.id).toBe("gpt-5")
  })

  test("pickSelectedModel falls back to preferred committed selection when draft is absent", () => {
    const models = [
      { id: "gpt-5", provider: { id: "openai" } },
      { id: "gpt-5.4", provider: { id: "openai" } },
    ]

    const selected = pickSelectedModel({
      selected: { providerID: "openai", modelID: "missing" },
      preferred: { providerID: "openai", modelID: "gpt-5.4" },
      models,
    })

    expect(selected?.id).toBe("gpt-5.4")
  })

  test("sameModelSelectorSelection compares provider/model/account as draft dirty key", () => {
    expect(
      sameModelSelectorSelection(
        { providerID: "openai", modelID: "gpt-5", accountID: "acct-a" },
        { providerID: "openai", modelID: "gpt-5", accountID: "acct-a" },
      ),
    ).toBe(true)

    expect(
      sameModelSelectorSelection(
        { providerID: "openai", modelID: "gpt-5", accountID: "acct-a" },
        { providerID: "openai", modelID: "gpt-5", accountID: "acct-b" },
      ),
    ).toBe(false)
  })

  test("normalizeProviderKey keeps provider-key normalization behavior", () => {
    expect(normalizeProviderKey("openai-api-primary")).toBe("openai")
    expect(normalizeProviderKey("google-api")).toBe("google-api")
  })
})
