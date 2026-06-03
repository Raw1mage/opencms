import { describe, it, expect, mock, beforeEach } from "bun:test"
import { ClaudeCliPlugin } from "./index"

describe("claude-cli Plugin", () => {
  let plugin: any
  const mockInput: any = {
    client: {
      auth: {
        set: mock(async () => {}),
      },
    },
  }

  beforeEach(async () => {
    plugin = await ClaudeCliPlugin(mockInput)
  })

  it("should register as claude-cli provider", () => {
    expect(plugin.auth.provider).toBe("claude-cli")
  })

  it("should have two auth methods (subscription + console)", () => {
    expect(plugin.auth.methods).toHaveLength(2)
    expect(plugin.auth.methods[0].label).toContain("subscription")
    expect(plugin.auth.methods[0].type).toBe("oauth")
    expect(plugin.auth.methods[1].label).toContain("Console")
    expect(plugin.auth.methods[1].type).toBe("oauth")
  })

  it("should return empty object for non-OAuth auth", async () => {
    const getAuth = async () => ({ type: "api", key: "sk-test" })
    const mockProvider = { models: {} }
    const result = await plugin.auth.loader(getAuth, mockProvider)
    expect(result).toEqual({})
  })

  it("should return getModel for OAuth auth", async () => {
    const mockAuth = {
      type: "oauth",
      access: "mock-access-token",
      refresh: "mock-refresh-token",
      expires: Date.now() + 3600000,
      orgID: "mock-org-id",
      email: "test@example.com",
      accountId: "test@example.com",
    }

    const getAuth = async () => mockAuth
    const mockProvider = {
      models: {
        "claude-sonnet-4-5": { cost: { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } } },
      },
    }

    const result = await plugin.auth.loader(getAuth, mockProvider)

    // Should have getModel function
    expect(typeof result.getModel).toBe("function")

    // Should pass through credentials
    expect(result.type).toBe("oauth")
    expect(result.refresh).toBe("mock-refresh-token")
    expect(result.access).toBe("mock-access-token")
    expect(result.email).toBe("test@example.com")

    // Should NOT have fetch (dead code removed)
    expect(result.fetch).toBeUndefined()

    // Should reset cost for subscription models
    expect(mockProvider.models["claude-sonnet-4-5"].cost.input).toBe(0)
    expect(mockProvider.models["claude-sonnet-4-5"].cost.output).toBe(0)
  })

  it("should not import @ai-sdk/anthropic", async () => {
    // Verify our plugin's import chain doesn't include @ai-sdk/anthropic
    const indexSource = await Bun.file(import.meta.dir + "/index.ts").text()
    const authSource = await Bun.file(import.meta.dir + "/auth.ts").text()
    expect(indexSource).not.toContain("@ai-sdk/anthropic")
    expect(authSource).not.toContain("@ai-sdk/anthropic")
  })

  // Regression guard for the 2026-06-03 token-landing bug: the provider-internal
  // ensureValidToken refresh (provider.ts:478) rotates the refresh_token mid-session;
  // if createClaudeCode is not given an onTokenRefresh callback, the rotation is lost
  // and the next process start replays a consumed token → invalid_grant → forced
  // re-login. createClaudeCode MUST be wired with the persist helper.
  it("wires onTokenRefresh into createClaudeCode so mid-session rotations persist", async () => {
    const src = await Bun.file(import.meta.dir + "/index.ts").text()
    // The shared persist helper exists and writes to the real storage account.
    expect(src).toContain("persistRefreshedToken")
    expect(src).toMatch(/Account\.update\("claude-cli",\s*storageId/)
    // createClaudeCode is invoked WITH the onTokenRefresh callback (the missing link).
    expect(src).toMatch(/onTokenRefresh:\s*persistRefreshedToken/)
    // Both refresh paths funnel through the one helper (explicit getModel refresh too).
    expect(src).toMatch(/await persistRefreshedToken\(creds\)/)
  })

  it("persist resolves the OPENCODE storage id, not the claude-side accountId", async () => {
    const src = await Bun.file(import.meta.dir + "/index.ts").text()
    // storageId prefers the loader accountId, falls back to base-token reverse lookup.
    expect(src).toMatch(/const storageId = accountId \|\| \(await Account\.findByRefreshToken\("claude-cli", lastKnownRefresh\)\)/)
    // lastKnownRefresh advances after each persist so the fallback survives successive rotations.
    expect(src).toContain("lastKnownRefresh = refreshed.refresh")
  })
})
