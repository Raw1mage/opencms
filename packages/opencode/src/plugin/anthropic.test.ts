import { describe, it, expect, mock } from "bun:test"
import { AnthropicAuthPlugin } from "./anthropic"

describe("Anthropic Plugin CLI Protocol", () => {
  it("should apply claude-code beta strategy without sessions API", async () => {
    // Mock fetch
    const originalFetch = global.fetch
    const fetchMock = mock(async (url: any, init: any) => {
      const urlStr = url.toString()
      if (urlStr.includes("/v1/messages")) return new Response(JSON.stringify({ content: [] }), { status: 200 })
      return new Response("{}", { status: 200 })
    })
    global.fetch = fetchMock as any

    try {
      const mockAuth = {
        type: "oauth" as const,
        access: "fake-token",
        refresh: "fake-refresh",
        expires: Date.now() + 10000,
        orgID: "fake-org",
      }

      const mockClient = {
        auth: {
          get: () => mockAuth,
          set: () => {},
        },
      } as any

      const plugin = await AnthropicAuthPlugin({ client: mockClient } as any)
      const authLoader = plugin.auth!.loader!

      // Get the fetch wrapper
      const loadedAuth = await authLoader(async () => mockAuth, { models: {} } as any)

      const customFetch = loadedAuth.fetch!

      // Prepare request
      const body = JSON.stringify({
        model: "claude-3-5-sonnet-20240620",
        tools: [
          {
            name: "test_tool",
            description: "test",
            input_schema: { type: "object", properties: {} },
          },
        ],
        messages: [{ role: "user", content: "hello" }],
      })

      const headers = new Headers()
      headers.set("session_id", "test-session-123")
      headers.set("anthropic-beta", "test-beta")
      headers.set("x-app", "cli")

      await customFetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers,
        body,
      })

      // Verification
      const calls = fetchMock.mock.calls

      // 1. Sessions API should NOT be called
      const sessionCall = calls.find((c) => c[0].toString().includes("/v1/sessions"))
      expect(sessionCall).toBeUndefined()

      // 2. Check messages call
      const messageCall = calls.find((c) => c[0].toString().includes("/v1/messages"))
      expect(messageCall).toBeDefined()
      if (messageCall) {
        const messageUrl = new URL(messageCall[0].toString())
        expect(messageUrl.searchParams.get("beta")).toBe("true")

        const messageBody = JSON.parse(messageCall[1].body as string)
        expect(messageBody.tools[0].name).toBe("mcp_test_tool")

        // 3. Check headers
        const reqHeaders = messageCall[1].headers as Headers
        expect(reqHeaders.get("anthropic-version")).toBe("2023-06-01")
        expect(reqHeaders.get("User-Agent")?.startsWith("claude-cli/")).toBe(true)
        expect(reqHeaders.get("anthropic-beta")?.includes("claude-code-20250219")).toBe(true)
        expect(reqHeaders.get("anthropic-beta")?.includes("oauth-2025-04-20")).toBe(true)
        expect(reqHeaders.get("anthropic-beta")?.includes("test-beta")).toBe(true)
        expect(reqHeaders.has("session_id")).toBe(false)
        expect(reqHeaders.has("x-app")).toBe(false)
      }
    } finally {
      global.fetch = originalFetch
    }
  })
})
