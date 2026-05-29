/**
 * Regression tests for the claude-cli OAuth add-account 429 fix (2026-05-30).
 *
 * Two subtle, easy-to-regress wire details — both were production bugs and the
 * User-Agent one was briefly self-inflicted during RCA:
 *
 *  1. Subscription (max) login must authorize at claude.com/cai, NOT the console
 *     server platform.claude.com. Upstream selects by loginWithClaudeAi.
 *  2. The OAuth token endpoint throttles the `claude-code/<ver>` User-Agent
 *     (429 before credential validation). The official CLI's OAuth calls go
 *     through plain axios, so we MUST send an `axios/*` UA on exchange/refresh,
 *     never `claude-code/<ver>`.
 *
 * See: specs/claude-cli/cli-reversed-spec/chapters/protocol-datasheets.md
 *      §2.1 (authorize host) and §3.5 (token-endpoint UA throttle).
 */
import { describe, expect, test, afterEach } from "bun:test"
import { authorize, exchange, refreshToken } from "../src/auth.js"

const fakePKCE = async () => ({ challenge: "test-challenge", verifier: "test-verifier" })

describe("authorize() — host selection by mode", () => {
  test("subscription (max) authorizes at claude.com/cai, not the console server", async () => {
    const { url } = await authorize("max", fakePKCE)
    const u = new URL(url)
    expect(u.origin).toBe("https://claude.com")
    expect(u.pathname).toBe("/cai/oauth/authorize")
    expect(url).not.toContain("platform.claude.com/oauth/authorize")
  })

  test("console (API key) authorizes at platform.claude.com", async () => {
    const { url } = await authorize("console", fakePKCE)
    const u = new URL(url)
    expect(u.origin).toBe("https://platform.claude.com")
    expect(u.pathname).toBe("/oauth/authorize")
  })

  test("redirect_uri is always platform.claude.com regardless of mode", async () => {
    for (const mode of ["max", "console"] as const) {
      const { url } = await authorize(mode, fakePKCE)
      const redirect = new URL(url).searchParams.get("redirect_uri")
      expect(redirect).toBe("https://platform.claude.com/oauth/code/callback")
    }
  })
})

describe("OAuth token-endpoint User-Agent — must be axios, never claude-code", () => {
  const original = globalThis.fetch
  let captured: { url: string; headers: Record<string, string> } | null = null

  afterEach(() => {
    globalThis.fetch = original
    captured = null
  })

  function stubFetch(json: Record<string, unknown>) {
    globalThis.fetch = (async (input: any, init: any) => {
      captured = {
        url: typeof input === "string" ? input : input.url,
        headers: init?.headers ?? {},
      }
      return {
        ok: true,
        status: 200,
        json: async () => json,
        text: async () => JSON.stringify(json),
      } as unknown as Response
    }) as typeof fetch

    return () => captured!.headers["User-Agent"]
  }

  test("exchange() sends an axios User-Agent, not claude-code/<ver>", async () => {
    const ua = stubFetch({ refresh_token: "r", access_token: "a", expires_in: 3600 })
    await exchange("code#state", "verifier")
    expect(captured!.url).toBe("https://platform.claude.com/v1/oauth/token")
    expect(ua()).toMatch(/^axios\//)
    expect(ua()).not.toMatch(/claude-code/)
  })

  test("refreshToken() sends an axios User-Agent, not claude-code/<ver>", async () => {
    const ua = stubFetch({ access_token: "a", expires_in: 3600, refresh_token: "r2" })
    await refreshToken("some-refresh-token")
    expect(captured!.url).toBe("https://platform.claude.com/v1/oauth/token")
    expect(ua()).toMatch(/^axios\//)
    expect(ua()).not.toMatch(/claude-code/)
  })
})
