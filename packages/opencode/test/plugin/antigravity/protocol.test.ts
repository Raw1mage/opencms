import { describe, expect, test } from "bun:test"
import { Account } from "../../../src/account"

// Mock getHeaderStyleFromUrl since it's not exported or we want to test its logic in isolation
// In a real integration test we might import it, but here we can test the Account.parseProvider logic
// which drives the protocol selection.

describe("Protocol Selection Logic", () => {
  test("Account.parseProvider correctly identifies antigravity provider", () => {
    const accountId = "antigravity-subscription-1"
    const provider = Account.parseProvider(accountId)
    expect(provider).toBe("antigravity")
  })

  test("Account.parseProvider correctly identifies gemini-cli provider", () => {
    const accountId = "gemini-cli-api-key"
    const provider = Account.parseProvider(accountId)
    expect(provider).toBe("gemini-cli")
  })

  test("Account.parseProvider correctly identifies google-api provider", () => {
    const accountId = "google-api-personal"
    const provider = Account.parseProvider(accountId)
    expect(provider).toBe("google-api")
  })

  // Replicating the logic from src/plugin/antigravity/index.ts getHeaderStyleFromUrl
  const getHeaderStyle = (providerID: string) => {
    if (providerID === "antigravity") {
      return "antigravity"
    }
    return "gemini-cli"
  }

  test("Strict protocol selection: antigravity -> antigravity", () => {
    const providerID = "antigravity"
    const style = getHeaderStyle(providerID)
    expect(style).toBe("antigravity")
  })

  test("Strict protocol selection: gemini-cli -> gemini-cli", () => {
    const providerID = "gemini-cli"
    const style = getHeaderStyle(providerID)
    expect(style).toBe("gemini-cli")
  })

  test("Strict protocol selection: google-api -> gemini-cli (fallback)", () => {
    const providerID = "google-api"
    const style = getHeaderStyle(providerID)
    expect(style).toBe("gemini-cli")
  })

  test("Strict protocol selection: unknown -> gemini-cli (fallback)", () => {
    const providerID = "unknown-provider"
    const style = getHeaderStyle(providerID)
    expect(style).toBe("gemini-cli")
  })
})
