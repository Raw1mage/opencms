import { describe, expect, test } from "bun:test"
import { buildAccountRows, buildProviderRows, filterModelsForMode, pickSelectedAccount } from "./model-selector-state"

describe("model selector state", () => {
  test("provider rows are built from provider universe and account families", () => {
    const rows = buildProviderRows({
      providers: [
        { id: "openai-api-primary", name: "OpenAI Primary" },
        { id: "google-api", name: "Google API" },
      ],
      accountFamilies: {
        "claude-cli": { accounts: { a1: {} } },
      },
      disabledProviders: ["google-api"],
    })

    expect(rows.some((row) => row.family === "openai")).toBe(true)
    expect(rows.some((row) => row.family === "claude-cli")).toBe(true)
    expect(rows.find((row) => row.family === "google-api")?.enabled).toBe(false)
  })

  test("account rows keep stable label ordering and include cooldown reason", () => {
    const now = 1_000
    const rows = buildAccountRows({
      selectedProviderFamily: "openai",
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
      selectedProviderFamily: "openai",
      accountFamilies,
      formatCooldown: (minutes) => `cooldown ${minutes}m`,
    })

    const after = buildAccountRows({
      selectedProviderFamily: "openai",
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

  test("favorites mode only keeps visible models in selected provider family", () => {
    const models = [
      { id: "m1", provider: { id: "openai-api-primary" } },
      { id: "m2", provider: { id: "openai-api-primary" } },
      { id: "m3", provider: { id: "google-api" } },
    ]

    const rows = filterModelsForMode({
      models,
      providerFamily: "openai",
      mode: "favorites",
      isVisible: (key) => key.modelID === "m2",
    })

    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe("m2")
  })

  test("all mode keeps all models in selected provider family", () => {
    const models = [
      { id: "m1", provider: { id: "openai-api-primary" } },
      { id: "m2", provider: { id: "openai-api-primary" } },
      { id: "m3", provider: { id: "google-api" } },
    ]

    const rows = filterModelsForMode({
      models,
      providerFamily: "openai",
      mode: "all",
      isVisible: () => false,
    })

    expect(rows.map((row) => row.id)).toEqual(["m1", "m2"])
  })
})
