import { describe, expect, it, mock, beforeEach } from "bun:test"
import { AnthropicAuthPlugin } from "./anthropic"

// Mock log to avoid noise
mock.module("../util/log", () => ({
  Log: {
    create: () => ({
      info: () => {},
      debug: () => {},
      error: () => {},
      warn: () => {},
    }),
  },
}))

describe("claude-cli Protocol Mimicry", () => {
  let plugin: any
  const mockInput: any = {
    client: {
      auth: {
        set: mock(async () => {}),
      },
    },
  }

  beforeEach(async () => {
    plugin = await AnthropicAuthPlugin(mockInput)
  })

  it("should correctly identify its provider as claude-cli", () => {
    expect(plugin.auth.provider).toBe("claude-cli")
  })

  it("should use ?beta=true and mcp_ tool prefix strategy", async () => {
    const mockAuth = {
      type: "oauth",
      access: "mock-access-token",
      refresh: "mock-refresh-token",
      expires: Date.now() + 3600000,
      orgID: "mock-org-id",
    }

    const getAuth = async () => mockAuth
    const mockProvider = { models: {} }

    const loaderResult = await plugin.auth.loader(getAuth, mockProvider)
    expect(loaderResult.isClaudeCode).toBe(true)

    const originalFetch = globalThis.fetch
    const fetchHistory: any[] = []

    // Mock global fetch to capture requests
    globalThis.fetch = mock(async (input: any, init: any) => {
      const url = input.toString()
      const headers = init.headers instanceof Headers ? init.headers : new Headers(init.headers)
      fetchHistory.push({ url, body: init.body ? JSON.parse(init.body) : null, headers })

      // Return a mock streaming response
      const mockBody = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"type":"message","content":[]}'))
          controller.close()
        },
      })
      return new Response(mockBody, { status: 200 })
    }) as any

    try {
      // Simulate a chat request with tools
      const payload = {
        model: "claude-3-opus-latest",
        messages: [{ role: "user", content: "hello" }],
        tools: [{ name: "read_file", description: "Read a file" }],
      }

      await loaderResult.fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        body: JSON.stringify(payload),
        headers: {},
      })

      // 1. Check if ?beta=true was added to URL
      const messageRequest = fetchHistory.find((h) => h.url.includes("/v1/messages"))
      expect(messageRequest).toBeDefined()
      expect(messageRequest.url).toContain("beta=true")

      // 2. Check if tools were prefixed with mcp_
      expect(messageRequest.body.tools[0].name).toBe("mcp_read_file")

      // 3. Check required headers
      expect(messageRequest.headers.get("anthropic-beta")).toContain("oauth-2025-04-20")
      expect(messageRequest.headers.get("x-anthropic-billing-header")).toBeDefined()
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("should sanitize OpenCode references in system prompt", async () => {
    const mockAuth = {
      type: "oauth",
      access: "mock-access-token",
      refresh: "mock-refresh-token",
      expires: Date.now() + 3600000,
      orgID: "mock-org-id",
    }

    const getAuth = async () => mockAuth
    const mockProvider = { models: {} }

    const loaderResult = await plugin.auth.loader(getAuth, mockProvider)
    const originalFetch = globalThis.fetch
    const fetchHistory: any[] = []

    globalThis.fetch = mock(async (input: any, init: any) => {
      fetchHistory.push({ url: input.toString(), body: init.body ? JSON.parse(init.body) : null })
      const mockBody = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"type":"message","content":[]}'))
          controller.close()
        },
      })
      return new Response(mockBody, { status: 200 })
    }) as any

    try {
      const payload = {
        model: "claude-3-opus-latest",
        messages: [{ role: "user", content: "hello" }],
        system: [{ type: "text", text: "You are OpenCode assistant. Use opencode tools." }],
      }

      await loaderResult.fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        body: JSON.stringify(payload),
        headers: {},
      })

      const request = fetchHistory[0]
      expect(request.body.system[0].text).toBe("You are Claude Code assistant. Use Claude tools.")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("should strip mcp_ prefix from response tool names", async () => {
    const mockAuth = {
      type: "oauth",
      access: "mock-access-token",
      refresh: "mock-refresh-token",
      expires: Date.now() + 3600000,
      orgID: "mock-org-id",
    }

    const getAuth = async () => mockAuth
    const mockProvider = { models: {} }

    const loaderResult = await plugin.auth.loader(getAuth, mockProvider)
    const originalFetch = globalThis.fetch

    globalThis.fetch = mock(async () => {
      // Return response with mcp_ prefixed tool name
      const mockBody = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"type":"tool_use","name":"mcp_read_file"}'))
          controller.close()
        },
      })
      return new Response(mockBody, { status: 200 })
    }) as any

    try {
      const response = await loaderResult.fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        body: JSON.stringify({
          model: "claude-3-opus-latest",
          messages: [{ role: "user", content: "hello" }],
        }),
        headers: {},
      })

      const reader = response.body!.getReader()
      const { value } = await reader.read()
      const text = new TextDecoder().decode(value)

      // mcp_ prefix should be stripped from response
      expect(text).toContain('"name": "read_file"')
      expect(text).not.toContain("mcp_read_file")
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
