import { test, expect, describe } from "bun:test"
import { ProviderAvailability } from "../../src/provider/availability"

describe("ProviderAvailability.availabilityFor", () => {
  const ctx = (hasAccount: string[], override: string[]) => ({
    hasAccount: new Set(hasAccount),
    overrideDisabled: new Set(override),
  })

  test("provider with account and no override is enabled", () => {
    expect(ProviderAvailability.availabilityFor("openai", ctx(["openai"], []))).toBe("enabled")
  })

  test("provider without account is no-account", () => {
    expect(ProviderAvailability.availabilityFor("groq", ctx(["openai"], []))).toBe("no-account")
  })

  test("user override beats account presence", () => {
    // Operator has an openai account but explicitly disabled it via
    // disabled_providers. The override wins.
    expect(ProviderAvailability.availabilityFor("openai", ctx(["openai"], ["openai"]))).toBe("disabled")
  })

  test("override without account still resolves to disabled (redundant but harmless)", () => {
    expect(ProviderAvailability.availabilityFor("groq", ctx([], ["groq"]))).toBe("disabled")
  })
})

describe("ProviderAvailability.isAllowed", () => {
  test("only enabled is allowed; disabled and no-account are not", () => {
    const hasAccount = new Set(["openai", "anthropic"])
    const overrideDisabled = new Set(["anthropic"])
    expect(ProviderAvailability.isAllowed("openai", { hasAccount, overrideDisabled })).toBe(true)
    expect(ProviderAvailability.isAllowed("anthropic", { hasAccount, overrideDisabled })).toBe(false)
    expect(ProviderAvailability.isAllowed("groq", { hasAccount, overrideDisabled })).toBe(false)
  })
})
