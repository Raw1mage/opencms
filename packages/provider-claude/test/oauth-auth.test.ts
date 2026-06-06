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
import { authorize, exchange, refreshToken, fetchProfile } from "../src/auth.js"

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

describe("authorize() — scope parity with upstream (bx8 union, both flows)", () => {
  // Upstream `bx8` = union($3q console, zR$ claude.ai) sent for BOTH login
  // types. Subscription must NOT strip org:create_api_key (that was a
  // wrong-host artifact). See protocol-datasheets.md §2.2.
  const UPSTREAM_AUTHORIZE_SCOPE =
    "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload"

  test("both flows send the identical upstream union scope (incl. org:create_api_key)", async () => {
    const scopes = await Promise.all(
      (["max", "console"] as const).map(async (mode) => {
        const { url } = await authorize(mode, fakePKCE)
        return new URL(url).searchParams.get("scope")
      }),
    )
    expect(scopes[0]).toBe(UPSTREAM_AUTHORIZE_SCOPE)
    expect(scopes[1]).toBe(UPSTREAM_AUTHORIZE_SCOPE)
    expect(scopes[0]).toBe(scopes[1]) // upstream does not vary scope by login type
  })

  test("refresh grant uses the narrower set WITHOUT org:create_api_key (upstream zR$)", async () => {
    // Guard the inverse: the refresh body must not carry the org scope.
    const original = globalThis.fetch
    let body: any = null
    globalThis.fetch = (async (_input: any, init: any) => {
      body = JSON.parse(init.body)
      return { ok: true, status: 200, json: async () => ({ access_token: "a", expires_in: 3600 }) } as unknown as Response
    }) as typeof fetch
    try {
      await refreshToken("r")
      expect(body.scope).not.toContain("org:create_api_key")
      expect(body.scope).toContain("user:inference")
    } finally {
      globalThis.fetch = original
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

describe("fetchProfile() — identity parsing (phantom-account root cause)", () => {
  const original = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = original
  })

  function stubProfile(json: Record<string, unknown>) {
    globalThis.fetch = (async () =>
      ({ ok: true, status: 200, json: async () => json }) as unknown as Response) as typeof fetch
  }

  test("reads email from the nested account.email_address (official shape)", async () => {
    // The real /api/oauth/profile response nests identity under account/organization.
    stubProfile({
      account: { uuid: "acc-uuid", email_address: "user@example.com" },
      organization: { uuid: "org-uuid" },
    })
    const profile = await fetchProfile("access-token")
    expect(profile.email).toBe("user@example.com")
    expect(profile.orgID).toBe("org-uuid")
  })

  test("does NOT silently return an empty email for the nested shape", async () => {
    // Regression guard: the old top-level `emailAddress||email` read returned
    // undefined here, degrading every re-login into a fresh duplicate account.
    stubProfile({
      account: { uuid: "acc-uuid", email_address: "user@example.com" },
      organization: { uuid: "org-uuid" },
    })
    const profile = await fetchProfile("access-token")
    expect(profile.email).toBeTruthy()
  })

  test("still honors legacy top-level fields as a fallback", async () => {
    stubProfile({ emailAddress: "legacy@example.com", organizationUuid: "org-legacy" })
    const profile = await fetchProfile("access-token")
    expect(profile.email).toBe("legacy@example.com")
    expect(profile.orgID).toBe("org-legacy")
  })
})
