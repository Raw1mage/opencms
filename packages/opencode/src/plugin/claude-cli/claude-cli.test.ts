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
})
