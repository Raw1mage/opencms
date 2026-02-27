import { describe, expect, test } from "bun:test"
import { buildAccountRows, buildProviderRows, filterModelsForMode } from "./model-selector-state"

describe("model selector state", () => {
  test("provider rows are built from provider universe and account families", () => {
    const rows = buildProviderRows({
      providers: [
        { id: "openai-api-primary", name: "OpenAI Primary" },
        { id: "google-api", name: "Google API" },
      ],
      accountFamilies: {
        antigravity: { accounts: { a1: {} } },
      },
      disabledProviders: ["google-api"],
    })

    expect(rows.some((row) => row.family === "openai")).toBe(true)
    expect(rows.some((row) => row.family === "antigravity")).toBe(true)
    expect(rows.find((row) => row.family === "google-api")?.enabled).toBe(false)
  })

  test("account rows prioritize active account and include cooldown reason", () => {
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

    expect(rows[0]?.id).toBe("acct2")
    expect(rows.find((row) => row.id === "acct1")?.unavailable).toBe("cooldown 2m")
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
