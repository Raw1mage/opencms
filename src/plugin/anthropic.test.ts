import { describe, it, expect, mock } from "bun:test"
import { AnthropicAuthPlugin } from "./anthropic"

describe("Anthropic Plugin CLI Protocol", () => {
  it("should inject session_id and other fields into messages", async () => {
    // Mock fetch
    const originalFetch = global.fetch
    const fetchMock = mock(async (url: any, init: any) => {
      const urlStr = url.toString()
      if (urlStr.includes("/v1/sessions")) {
        return new Response("{}", { status: 200 })
      }
      if (urlStr.includes("/v1/messages")) {
        return new Response(JSON.stringify({ content: [] }), { status: 200 })
      }
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
        messages: [{ role: "user", content: "hello" }],
      })

      const headers = new Headers()
      headers.set("session_id", "test-session-123")
      headers.set("anthropic-beta", "test-beta")

      await customFetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers,
        body,
      })

      // Verification
      const calls = fetchMock.mock.calls

      // 1. Check if sessions endpoint was called
      const sessionCall = calls.find((c) => c[0].toString().includes("/v1/sessions"))
      expect(sessionCall).toBeDefined()
      if (sessionCall) {
        const sessionBody = JSON.parse(sessionCall[1].body as string)
        expect(sessionBody.uuid).toBe("test-session-123")
      }

      // 2. Check messages call
      const messageCall = calls.find((c) => c[0].toString().includes("/v1/messages"))
      expect(messageCall).toBeDefined()
      if (messageCall) {
        const messageBody = JSON.parse(messageCall[1].body as string)

        expect(messageBody.session_id).toBe("test-session-123")
        expect(messageBody.user_type).toBe("user")
        expect(messageBody.client_type).toBe("cli")

        // 3. Check headers
        const reqHeaders = messageCall[1].headers as Headers
        expect(reqHeaders.get("x-app")).toBe("cli")
        expect(reqHeaders.get("x-anthropic-additional-protection")).toBe("true")
        // Ensure session_id header is removed
        expect(reqHeaders.has("session_id")).toBe(false)
      }
    } finally {
      global.fetch = originalFetch
    }
  })
})
