import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RateLimit } from "../../src/server/rate-limit"
import { RequestUser } from "../../src/runtime/request-user"
import { SessionCache } from "../../src/server/session-cache"
import { ServerRoutes } from "../../src/server/routes/cache-health"
import { Tweaks } from "../../src/config/tweaks"

const TWEAKS_ENV = "OPENCODE_TWEAKS_PATH"

let tmpDir: string
let prevEnv: string | undefined

function writeTweaks(contents: string): string {
  const p = join(tmpDir, "tweaks.cfg")
  writeFileSync(p, contents, "utf8")
  process.env[TWEAKS_ENV] = p
  return p
}

function buildApp() {
  const app = new Hono()
  app.route("/api/v2/server", ServerRoutes())
  return app
}

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "cache-health-test-"))
  prevEnv = process.env[TWEAKS_ENV]
  Tweaks.resetForTesting()
  SessionCache.resetForTesting()
  RateLimit.resetForTesting()
})

afterEach(() => {
  SessionCache.resetForTesting()
  RateLimit.resetForTesting()
  Tweaks.resetForTesting()
  if (prevEnv === undefined) delete process.env[TWEAKS_ENV]
  else process.env[TWEAKS_ENV] = prevEnv
  rmSync(tmpDir, { recursive: true, force: true })
})

describe("GET /api/v2/server/cache/health", () => {
  test("returns placeholder state when no stats providers registered", async () => {
    writeTweaks("")
    const app = buildApp()
    const res = await app.request("/api/v2/server/cache/health")
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body).toMatchObject({
      entries: 0,
      maxEntries: 500,
      hitRate: 0,
      missRate: 0,
      subscriptionAlive: false,
      ttlSec: 60,
      rateLimit: { enabled: true, allowedCount: 0, throttledCount: 0, activeBuckets: 0 },
    })
    expect(body.source.present).toBe(true)
  })

  test("reflects session-cache stats after miss + hit + invalidate", async () => {
    writeTweaks("session_cache_ttl_sec=60\nsession_cache_max_entries=10")
    SessionCache.setSubscriptionAliveForTesting(true)
    // Seed real session-cache activity.
    await SessionCache.get("session:ses_A", "ses_A", async () => ({ data: "x", version: 0 }))
    await SessionCache.get("session:ses_A", "ses_A", async () => ({ data: "x", version: 0 }))
    SessionCache.invalidate("ses_A", "test")

    // Register the session-cache as the stats provider (normally done in
    // registerInvalidationSubscriber, but we want to test the wiring).
    const { registerCacheStatsProvider } = await import("../../src/server/routes/cache-health")
    registerCacheStatsProvider(SessionCache.stats)

    const app = buildApp()
    const res = await app.request("/api/v2/server/cache/health")
    const body = (await res.json()) as any
    expect(body.invalidationCount).toBeGreaterThan(0)
    expect(body.subscriptionAlive).toBe(true)
    expect(body.hitRate).toBeGreaterThan(0)
    expect(body.missRate).toBeGreaterThan(0)
  })

  test("reflects rate-limit stats after throttle trip", async () => {
    writeTweaks("ratelimit_qps_per_user_per_path=1\nratelimit_burst=1")
    await RateLimit.logStartup() // registers the stats provider

    // Mount the real RateLimit middleware on a dummy route to drive stats.
    const driver = new Hono()
    driver.use(async (c, next) => RequestUser.provide("alice", () => next()))
    driver.use(RateLimit.middleware())
    driver.get("/api/v2/session/:id", (c) => c.text("ok"))
    await driver.request("/api/v2/session/ses_AAaaaaaaaaaaaaaaaaaaaaaaaaa")
    await driver.request("/api/v2/session/ses_AAaaaaaaaaaaaaaaaaaaaaaaaaa") // throttled

    const app = buildApp()
    const res = await app.request("/api/v2/server/cache/health")
    const body = (await res.json()) as any
    expect(body.rateLimit.allowedCount).toBeGreaterThanOrEqual(1)
    expect(body.rateLimit.throttledCount).toBeGreaterThanOrEqual(1)
    expect(body.rateLimit.activeBuckets).toBeGreaterThanOrEqual(1)
  })

  test("surfaces tweaks source (path + present)", async () => {
    const path = writeTweaks("session_cache_ttl_sec=30")
    const app = buildApp()
    const res = await app.request("/api/v2/server/cache/health")
    const body = (await res.json()) as any
    expect(body.ttlSec).toBe(30)
    expect(body.source.path).toBe(path)
    expect(body.source.present).toBe(true)
  })
})
