import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"

let configDir = ""
const publishUpdate = mock(async () => {})
const requireReady = mock(async () => {})
const activeGoogleAppIds = mock(async () => ["gmail", "google-calendar"])

class UsageStateError extends Error {
  info: unknown

  constructor(info: { message: string }) {
    super(info.message)
    this.name = "ManagedAppUsageStateError"
    this.info = info
  }
}

mock.module("@/global", () => ({
  Global: {
    Path: {
      get config() {
        return configDir
      },
    },
  },
}))

mock.module("@/mcp/app-registry", () => ({
  ManagedAppRegistry: {
    UsageStateError,
    publishUpdate,
    requireReady,
    activeGoogleAppIds,
  },
}))

mock.module("@/util/log", () => ({
  Log: {
    create: () => ({
      info: () => {},
      error: () => {},
    }),
  },
}))

describe("gauth shared refresh coordination", () => {
  const originalFetch = globalThis.fetch

  beforeEach(async () => {
    configDir = await fs.mkdtemp(path.join(os.tmpdir(), "gauth-test-"))
    publishUpdate.mockClear()
    requireReady.mockClear()
    activeGoogleAppIds.mockReset()
    activeGoogleAppIds.mockResolvedValue(["gmail", "google-calendar"])
    process.env.GOOGLE_CALENDAR_CLIENT_ID = "client-id"
    process.env.GOOGLE_CALENDAR_CLIENT_SECRET = "client-secret"
    process.env.GOOGLE_CALENDAR_TOKEN_URI = "https://oauth.test/token"
  })

  afterEach(async () => {
    globalThis.fetch = originalFetch
    delete process.env.GOOGLE_CALENDAR_CLIENT_ID
    delete process.env.GOOGLE_CALENDAR_CLIENT_SECRET
    delete process.env.GOOGLE_CALENDAR_TOKEN_URI
    if (configDir) {
      await fs.rm(configDir, { recursive: true, force: true })
    }
  })

  it("serializes concurrent shared refresh requests", async () => {
    await fs.writeFile(
      path.join(configDir, "gauth.json"),
      JSON.stringify({
        access_token: "stale-token",
        refresh_token: "refresh-token",
        expires_at: Date.now() - 60_000,
        token_type: "Bearer",
        updated_at: Date.now() - 120_000,
      }),
    )

    const fetchMock = mock(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            access_token: "fresh-token",
            refresh_token: "rotated-refresh-token",
            expires_in: 3600,
            token_type: "Bearer",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
    )
    globalThis.fetch = Object.assign((input: RequestInfo | URL, init?: RequestInit) => fetchMock(input, init), {
      preconnect: originalFetch.preconnect.bind(originalFetch),
    }) as typeof fetch

    const { readGAuthTokens, resolveGoogleAccessToken } = await import("./gauth")

    const [gmailToken, calendarToken] = await Promise.all([
      resolveGoogleAccessToken("gmail"),
      resolveGoogleAccessToken("google-calendar"),
    ])

    expect(gmailToken).toBe("fresh-token")
    expect(calendarToken).toBe("fresh-token")
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(requireReady).toHaveBeenCalledTimes(2)
    expect(publishUpdate).toHaveBeenCalledTimes(2)

    const stored = await readGAuthTokens()
    expect(stored).toMatchObject({
      access_token: "fresh-token",
      refresh_token: "rotated-refresh-token",
      token_type: "Bearer",
    })
  })

  it("publishes shared managed-app updates after a successful background sweep refresh", async () => {
    await fs.writeFile(
      path.join(configDir, "gauth.json"),
      JSON.stringify({
        access_token: "stale-token",
        refresh_token: "refresh-token",
        expires_at: Date.now() - 60_000,
        token_type: "Bearer",
        updated_at: Date.now() - 120_000,
      }),
    )

    const fetchMock = mock(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            access_token: "fresh-token",
            refresh_token: "rotated-refresh-token",
            expires_in: 3600,
            token_type: "Bearer",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
    )
    globalThis.fetch = Object.assign((input: RequestInfo | URL, init?: RequestInit) => fetchMock(input, init), {
      preconnect: originalFetch.preconnect.bind(originalFetch),
    }) as typeof fetch

    const { readGAuthTokens, sweepSharedGoogleAccessToken } = await import("./gauth")

    await expect(sweepSharedGoogleAccessToken()).resolves.toMatchObject({
      access_token: "fresh-token",
      refresh_token: "rotated-refresh-token",
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(requireReady).toHaveBeenCalledTimes(0)
    expect(publishUpdate).toHaveBeenCalledTimes(2)
    expect(publishUpdate).toHaveBeenCalledWith("gmail")
    expect(publishUpdate).toHaveBeenCalledWith("google-calendar")

    const stored = await readGAuthTokens()
    expect(stored).toMatchObject({
      access_token: "fresh-token",
      refresh_token: "rotated-refresh-token",
    })
  })

  it("returns null for background sweep when shared tokens are absent", async () => {
    const { sweepSharedGoogleAccessToken } = await import("./gauth")

    await expect(sweepSharedGoogleAccessToken()).resolves.toBeNull()
    expect(publishUpdate).toHaveBeenCalledTimes(0)
  })

  it("only publishes updates for active Google apps", async () => {
    activeGoogleAppIds.mockResolvedValue(["gmail"])
    await fs.writeFile(
      path.join(configDir, "gauth.json"),
      JSON.stringify({
        access_token: "stale-token",
        refresh_token: "refresh-token",
        expires_at: Date.now() - 60_000,
        token_type: "Bearer",
        updated_at: Date.now() - 120_000,
      }),
    )

    const fetchMock = mock(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            access_token: "fresh-token",
            refresh_token: "rotated-refresh-token",
            expires_in: 3600,
            token_type: "Bearer",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
    )
    globalThis.fetch = Object.assign((input: RequestInfo | URL, init?: RequestInit) => fetchMock(input, init), {
      preconnect: originalFetch.preconnect.bind(originalFetch),
    }) as typeof fetch

    const { sweepSharedGoogleAccessToken } = await import("./gauth")

    await expect(sweepSharedGoogleAccessToken()).resolves.toMatchObject({
      access_token: "fresh-token",
    })
    expect(publishUpdate).toHaveBeenCalledTimes(1)
    expect(publishUpdate).toHaveBeenCalledWith("gmail")
  })
})
