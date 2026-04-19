import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RateLimit } from "../../src/server/rate-limit"
import { RequestUser } from "../../src/runtime/request-user"
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

function buildApp(username: string | null) {
  const app = new Hono()
  app.use(async (c, next) => {
    if (username === null) return next()
    return RequestUser.provide(username, () => next())
  })
  app.use(RateLimit.middleware())
  app.get("/log", (c) => c.text("skip"))
  app.get("/api/v2/server/cache/health", (c) => c.json({ ok: true }))
  app.get("/api/v2/session/:id", (c) => c.text(`session ${c.req.param("id")}`))
  app.get("/api/v2/session/:id/message", (c) => c.text("msgs"))
  return app
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ratelimit-test-"))
  prevEnv = process.env[TWEAKS_ENV]
  Tweaks.resetForTesting()
  RateLimit.resetForTesting()
})

afterEach(() => {
  RateLimit.resetForTesting()
  Tweaks.resetForTesting()
  if (prevEnv === undefined) delete process.env[TWEAKS_ENV]
  else process.env[TWEAKS_ENV] = prevEnv
  rmSync(tmpDir, { recursive: true, force: true })
})

describe("RateLimit.normalizeRoutePattern", () => {
  test("collapses opencode ID segments to :id", () => {
    expect(
      RateLimit.normalizeRoutePattern("/api/v2/session/ses_26abcdefghijklmnopqrstuvwx/message"),
    ).toBe("/api/v2/session/:id/message")
  })

  test("leaves non-ID segments untouched", () => {
    expect(RateLimit.normalizeRoutePattern("/api/v2/global/health")).toBe("/api/v2/global/health")
  })

  test("collapses multiple ID segments independently", () => {
    const raw = "/api/v2/session/ses_26abcdefghijklmnopqrstuvwx/message/msg_27abcdefghijklmnopqrstuvwx"
    expect(RateLimit.normalizeRoutePattern(raw)).toBe("/api/v2/session/:id/message/:id")
  })
})

describe("RateLimit middleware", () => {
  test("allows requests under burst", async () => {
    writeTweaks("ratelimit_qps_per_user_per_path=5\nratelimit_burst=3")
    const app = buildApp("alice")
    for (let i = 0; i < 3; i++) {
      const res = await app.request("/api/v2/session/ses_26abcdefghijklmnopqrstuvwx")
      expect(res.status).toBe(200)
    }
  })

  test("throttles beyond burst with 429 + Retry-After", async () => {
    writeTweaks("ratelimit_qps_per_user_per_path=2\nratelimit_burst=2")
    const app = buildApp("alice")
    const path = "/api/v2/session/ses_26abcdefghijklmnopqrstuvwx"
    await app.request(path)
    await app.request(path)
    const third = await app.request(path)
    expect(third.status).toBe(429)
    const retry = third.headers.get("retry-after")
    expect(retry).toBeTruthy()
    expect(Number(retry)).toBeGreaterThanOrEqual(1)
    const body = (await third.json()) as { code: string; path: string; retryAfterSec: number }
    expect(body.code).toBe("RATE_LIMIT")
    expect(body.path).toBe("/api/v2/session/:id")
    expect(body.retryAfterSec).toBeGreaterThanOrEqual(1)
  })

  test("different route patterns hold independent buckets", async () => {
    writeTweaks("ratelimit_qps_per_user_per_path=1\nratelimit_burst=1")
    const app = buildApp("alice")
    const idPath = "/api/v2/session/ses_26abcdefghijklmnopqrstuvwx"
    const msgPath = idPath + "/message"
    expect((await app.request(idPath)).status).toBe(200)
    expect((await app.request(idPath)).status).toBe(429)
    expect((await app.request(msgPath)).status).toBe(200) // different pattern
  })

  test("session IDs collapse into a single bucket for the same pattern", async () => {
    writeTweaks("ratelimit_qps_per_user_per_path=1\nratelimit_burst=1")
    const app = buildApp("alice")
    const a = "/api/v2/session/ses_AAaaaaaaaaaaaaaaaaaaaaaaaaaa"
    const b = "/api/v2/session/ses_BBbbbbbbbbbbbbbbbbbbbbbbbbbb"
    expect((await app.request(a)).status).toBe(200)
    expect((await app.request(b)).status).toBe(429)
  })

  test("different users hold independent buckets", async () => {
    writeTweaks("ratelimit_qps_per_user_per_path=1\nratelimit_burst=1")
    const idPath = "/api/v2/session/ses_26abcdefghijklmnopqrstuvwx"
    const aliceApp = buildApp("alice")
    const bobApp = buildApp("bob")
    expect((await aliceApp.request(idPath)).status).toBe(200)
    expect((await aliceApp.request(idPath)).status).toBe(429)
    expect((await bobApp.request(idPath)).status).toBe(200)
  })

  test("exempt paths always pass", async () => {
    writeTweaks("ratelimit_qps_per_user_per_path=1\nratelimit_burst=1")
    const app = buildApp("alice")
    for (let i = 0; i < 10; i++) {
      const res = await app.request("/api/v2/server/cache/health")
      expect(res.status).toBe(200)
      const res2 = await app.request("/log")
      expect(res2.status).toBe(200)
    }
  })

  test("opencode.internal hostname is exempt", async () => {
    writeTweaks("ratelimit_qps_per_user_per_path=1\nratelimit_burst=1")
    const app = buildApp("alice")
    for (let i = 0; i < 5; i++) {
      const res = await app.request("http://opencode.internal/api/v2/session/ses_26abcdefghijklmnopqrstuvwx")
      expect(res.status).toBe(200)
    }
  })

  test("ratelimit_enabled=0 bypasses the middleware entirely", async () => {
    writeTweaks("ratelimit_enabled=0\nratelimit_qps_per_user_per_path=1\nratelimit_burst=1")
    const app = buildApp("alice")
    const path = "/api/v2/session/ses_26abcdefghijklmnopqrstuvwx"
    for (let i = 0; i < 10; i++) {
      const res = await app.request(path)
      expect(res.status).toBe(200)
    }
  })

  test("unresolvable username bypasses with warn (E-RATE-002)", async () => {
    writeTweaks("ratelimit_qps_per_user_per_path=1\nratelimit_burst=1")
    const app = buildApp(null)
    const path = "/api/v2/session/ses_26abcdefghijklmnopqrstuvwx"
    for (let i = 0; i < 5; i++) {
      const res = await app.request(path)
      expect(res.status).toBe(200)
    }
  })
})
