/**
 * auth.test.ts — upstream token revoke (Phase 1 of provider-hotfix)
 *
 * Mirrors upstream codex-rs 22f7ef1cb7: logout MUST POST the refresh token to
 * the /oauth/revoke endpoint before local teardown, fail-closed.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { revokeRefreshToken } from "./auth"

const realFetch = globalThis.fetch

type Call = { url: string; init: RequestInit | undefined }

function installFetch(response: Response): { calls: Call[] } {
  const calls: Call[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
      init,
    })
    return response.clone()
  }) as typeof fetch
  return { calls }
}

describe("revokeRefreshToken", () => {
  beforeEach(() => {
    globalThis.fetch = realFetch
  })
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  test("POSTs JSON token + token_type_hint=refresh_token to /oauth/revoke", async () => {
    const { calls } = installFetch(new Response(null, { status: 200 }))

    await revokeRefreshToken("refresh-abc123")

    expect(calls.length).toBe(1)
    expect(calls[0].url).toBe("https://auth.openai.com/oauth/revoke")
    expect(calls[0].init?.method).toBe("POST")
    const headers = calls[0].init?.headers as Record<string, string>
    expect(headers["Content-Type"]).toBe("application/json")
    const body = JSON.parse(calls[0].init?.body as string)
    expect(body.token).toBe("refresh-abc123")
    expect(body.token_type_hint).toBe("refresh_token")
    expect(body.client_id).toBeTruthy()
  })

  test("resolves on 204 (RFC 7009 compliant)", async () => {
    installFetch(new Response(null, { status: 204 }))
    await expect(revokeRefreshToken("rt")).resolves.toBeUndefined()
  })

  test("throws on non-2xx (fail-closed)", async () => {
    installFetch(new Response("{\"error\":\"invalid_token\"}", { status: 400 }))
    await expect(revokeRefreshToken("rt")).rejects.toThrow(/Token revoke failed: HTTP 400/)
  })

  test("throws on network error (fail-closed)", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed")
    }) as typeof fetch
    await expect(revokeRefreshToken("rt")).rejects.toThrow(/fetch failed/)
  })

  test("error message truncates long upstream body (no token leak)", async () => {
    // 300 chars of payload to exercise the 200-char cap.
    const bigBody = "x".repeat(300)
    installFetch(new Response(bigBody, { status: 500 }))
    let err: unknown
    try {
      await revokeRefreshToken("rt")
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message.length).toBeLessThan(260)
  })
})
