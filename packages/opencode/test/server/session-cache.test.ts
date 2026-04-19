import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Bus } from "../../src/bus"
import { MessageV2 } from "../../src/session/message-v2"
import { Session } from "../../src/session"
import { SessionCache } from "../../src/server/session-cache"
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

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "session-cache-test-"))
  prevEnv = process.env[TWEAKS_ENV]
  Tweaks.resetForTesting()
  SessionCache.resetForTesting()
})

afterEach(() => {
  SessionCache.resetForTesting()
  Tweaks.resetForTesting()
  if (prevEnv === undefined) delete process.env[TWEAKS_ENV]
  else process.env[TWEAKS_ENV] = prevEnv
  rmSync(tmpDir, { recursive: true, force: true })
})

async function withDefaultsAlive() {
  // Defaults: enabled, ttl=60s, max=500; mark subscription alive so memoization kicks in.
  writeTweaks("")
  SessionCache.setSubscriptionAliveForTesting(true)
}

describe("SessionCache.get", () => {
  test("first call is a miss and populates the cache", async () => {
    await withDefaultsAlive()
    let loaderCalls = 0
    const { data, hit } = await SessionCache.get(
      "messages:ses_A:400",
      "ses_A",
      async () => {
        loaderCalls += 1
        return { data: ["m1", "m2"], version: 0 }
      },
    )
    expect(loaderCalls).toBe(1)
    expect(hit).toBe(false)
    expect(data).toEqual(["m1", "m2"])
    expect(SessionCache.stats().entries).toBe(1)
  })

  test("second call hits the cache and skips the loader", async () => {
    await withDefaultsAlive()
    let loaderCalls = 0
    const loader = async () => {
      loaderCalls += 1
      return { data: "payload", version: 0 }
    }
    await SessionCache.get("session:ses_A", "ses_A", loader)
    const second = await SessionCache.get("session:ses_A", "ses_A", loader)
    expect(loaderCalls).toBe(1)
    expect(second.hit).toBe(true)
    expect(second.data).toBe("payload")
    const s = SessionCache.stats()
    expect(s.hitRate).toBeGreaterThan(0)
  })

  test("invalidate drops matching keys for a sessionID", async () => {
    await withDefaultsAlive()
    await SessionCache.get("session:ses_A", "ses_A", async () => ({ data: 1, version: 0 }))
    await SessionCache.get("messages:ses_A:400", "ses_A", async () => ({ data: 2, version: 0 }))
    await SessionCache.get("messages:ses_B:400", "ses_B", async () => ({ data: 3, version: 0 }))
    const dropped = SessionCache.invalidate("ses_A", "test")
    expect(dropped).toBe(2)
    expect(SessionCache.stats().entries).toBe(1)
  })

  test("bus event MessageV2.Event.Updated invalidates cache and bumps version", async () => {
    await withDefaultsAlive()
    SessionCache.registerInvalidationSubscriber()
    await SessionCache.get("messages:ses_A:400", "ses_A", async () => ({
      data: ["m1"],
      version: SessionCache.getVersion("ses_A"),
    }))
    expect(SessionCache.stats().entries).toBe(1)
    expect(SessionCache.getVersion("ses_A")).toBe(0)

    await Bus.publish(MessageV2.Event.Updated, {
      info: {
        id: "msg_new",
        sessionID: "ses_A",
        role: "user",
        time: { created: Date.now() },
      } as any,
    })

    // The subscriber is synchronous in its invalidation phase (bumpVersion +
    // delete keys); bus publish awaits it.
    expect(SessionCache.getVersion("ses_A")).toBe(1)
    expect(SessionCache.stats().entries).toBe(0)
    expect(SessionCache.stats().invalidationCount).toBeGreaterThan(0)
  })

  test("bus event MessageV2.Event.PartUpdated extracts sessionID from part", async () => {
    await withDefaultsAlive()
    SessionCache.registerInvalidationSubscriber()
    await SessionCache.get("messages:ses_B:400", "ses_B", async () => ({ data: "x", version: 0 }))

    await Bus.publish(MessageV2.Event.PartUpdated, {
      part: {
        id: "prt_1",
        sessionID: "ses_B",
        messageID: "msg_1",
        type: "text",
        text: "hi",
      } as any,
    })

    expect(SessionCache.getVersion("ses_B")).toBe(1)
    expect(SessionCache.stats().entries).toBe(0)
  })

  test("Session.Event.Deleted clears the version counter and entries", async () => {
    await withDefaultsAlive()
    SessionCache.registerInvalidationSubscriber()
    await SessionCache.get("session:ses_C", "ses_C", async () => ({ data: {}, version: 0 }))
    // Bump a few times so counter is non-zero.
    await Bus.publish(MessageV2.Event.Updated, {
      info: { id: "m1", sessionID: "ses_C", role: "user", time: { created: 0 } } as any,
    })
    expect(SessionCache.getVersion("ses_C")).toBe(1)

    await Bus.publish(Session.Event.Deleted, {
      info: { id: "ses_C" } as any,
    })
    expect(SessionCache.getVersion("ses_C")).toBe(0)
    expect(SessionCache.stats().entries).toBe(0)
  })

  test("TTL expiry is honoured — stale entry triggers a fresh load", async () => {
    writeTweaks("session_cache_ttl_sec=0\nsession_cache_max_entries=10")
    SessionCache.setSubscriptionAliveForTesting(true)
    let loaderCalls = 0
    const loader = async () => {
      loaderCalls += 1
      return { data: loaderCalls, version: loaderCalls }
    }
    await SessionCache.get("session:ses_D", "ses_D", loader)
    // With ttlSec=0, ttlMs=0; any positive age should trigger expiry.
    await new Promise((r) => setTimeout(r, 2))
    const second = await SessionCache.get("session:ses_D", "ses_D", loader)
    expect(loaderCalls).toBe(2)
    expect(second.hit).toBe(false)
    expect(SessionCache.stats().evictionCount).toBeGreaterThan(0)
  })

  test("LRU cap evicts the oldest entry when full", async () => {
    writeTweaks("session_cache_max_entries=2\nsession_cache_ttl_sec=60")
    SessionCache.setSubscriptionAliveForTesting(true)
    await SessionCache.get("messages:ses_A:400", "ses_A", async () => ({ data: "A", version: 0 }))
    await SessionCache.get("messages:ses_B:400", "ses_B", async () => ({ data: "B", version: 0 }))
    // Accessing A makes B the oldest.
    await SessionCache.get("messages:ses_A:400", "ses_A", async () => {
      throw new Error("should have hit")
    })
    await SessionCache.get("messages:ses_C:400", "ses_C", async () => ({ data: "C", version: 0 }))
    // B should have been evicted.
    expect(SessionCache.stats().entries).toBe(2)
    expect(SessionCache.stats().evictionCount).toBeGreaterThanOrEqual(1)
  })

  test("subscriptionAlive=false → loader runs every time and never memoizes", async () => {
    writeTweaks("")
    SessionCache.setSubscriptionAliveForTesting(false)
    let loaderCalls = 0
    const loader = async () => {
      loaderCalls += 1
      return { data: loaderCalls, version: 0 }
    }
    await SessionCache.get("session:ses_E", "ses_E", loader)
    await SessionCache.get("session:ses_E", "ses_E", loader)
    expect(loaderCalls).toBe(2)
    expect(SessionCache.stats().entries).toBe(0)
  })

  test("currentEtag format is W/\"<id>:<version>:<epoch>\"", async () => {
    await withDefaultsAlive()
    const etag = SessionCache.currentEtag("ses_TagA")
    expect(etag).toMatch(/^W\/"ses_TagA:\d+:[a-z0-9]+"$/)
  })

  test("isEtagMatch ignores whitespace and matches only the current version", async () => {
    await withDefaultsAlive()
    SessionCache.registerInvalidationSubscriber()
    const etag0 = SessionCache.currentEtag("ses_TagB")
    expect(SessionCache.isEtagMatch("ses_TagB", etag0)).toBe(true)
    expect(SessionCache.isEtagMatch("ses_TagB", "  " + etag0 + "\n")).toBe(true)
    // A write bumps the version → prior ETag must no longer match.
    await Bus.publish(MessageV2.Event.Updated, {
      info: { id: "m1", sessionID: "ses_TagB", role: "user", time: { created: 0 } } as any,
    })
    expect(SessionCache.isEtagMatch("ses_TagB", etag0)).toBe(false)
    const etag1 = SessionCache.currentEtag("ses_TagB")
    expect(SessionCache.isEtagMatch("ses_TagB", etag1)).toBe(true)
  })

  test("isEtagMatch returns false for missing / empty header", async () => {
    await withDefaultsAlive()
    expect(SessionCache.isEtagMatch("ses_TagC", undefined)).toBe(false)
    expect(SessionCache.isEtagMatch("ses_TagC", null)).toBe(false)
    expect(SessionCache.isEtagMatch("ses_TagC", "")).toBe(false)
  })

  test("cache disabled in tweaks → every call is a miss", async () => {
    writeTweaks("session_cache_enabled=0")
    SessionCache.setSubscriptionAliveForTesting(true)
    let loaderCalls = 0
    const loader = async () => {
      loaderCalls += 1
      return { data: "x", version: 0 }
    }
    await SessionCache.get("session:ses_F", "ses_F", loader)
    await SessionCache.get("session:ses_F", "ses_F", loader)
    expect(loaderCalls).toBe(2)
    expect(SessionCache.stats().entries).toBe(0)
  })
})
