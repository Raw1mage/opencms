import { describe, expect, test } from "bun:test"
import { buildHiddenSetFromRemote, normalizePreferenceProviderFamily } from "./model-preferences"

describe("model preferences normalization", () => {
  test("keeps anthropic distinct from claude-cli", () => {
    expect(normalizePreferenceProviderFamily("anthropic")).toBe("anthropic")
    expect(normalizePreferenceProviderFamily("claude-cli")).toBe("claude-cli")
  })

  test("buildHiddenSetFromRemote returns correct keys", () => {
    const hidden = buildHiddenSetFromRemote([
      { providerId: "claude-cli", modelID: "claude-sonnet-4-5" },
      { providerId: "openai", modelID: "gpt-4o" },
    ])

    expect(hidden.has("claude-cli:claude-sonnet-4-5")).toBe(true)
    expect(hidden.has("openai:gpt-4o")).toBe(true)
    expect(hidden.has("claude-cli:claude-opus-4-5")).toBe(false)
  })

  test("does not merge anthropic into claude-cli", () => {
    const hidden = buildHiddenSetFromRemote([
      { providerId: "anthropic", modelID: "claude-sonnet-4" },
    ])
    expect(hidden.has("anthropic:claude-sonnet-4")).toBe(true)
    expect(hidden.has("claude-cli:claude-sonnet-4")).toBe(false)
  })
})
