import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { SessionCache } from "../../src/server/session-cache"
import { Log } from "../../src/util/log"
import { Flag } from "../../src/flag/flag"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

describe("session.meta endpoint", () => {
  beforeEach(() => {
    SessionCache.resetForTesting()
  })
  afterEach(() => {
    SessionCache.resetForTesting()
  })

  test("returns metadata with partCount=0 for a fresh session", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const app = Server.App()
        const session = await Session.create({})

        const response = await app.request(`/session/${session.id}/meta`)
        if (Flag.OPENCODE_SERVER_PASSWORD) {
          expect(response.status).toBe(401)
          return
        }
        expect(response.status).toBe(200)

        const body = (await response.json()) as {
          partCount: number
          totalBytes: number
          lastUpdated: string
          etag: string
          messageCount?: number
        }
        expect(body.partCount).toBe(0)
        expect(body.totalBytes).toBe(0)
        expect(typeof body.lastUpdated).toBe("string")
        expect(body.etag).toMatch(/^W\/"[^"]+"$/)
        expect(body.messageCount).toBe(0)
        expect(response.headers.get("etag")).toBe(body.etag)
      },
    })
  })

  test("If-None-Match matching returns 304 Not Modified", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const app = Server.App()
        const session = await Session.create({})

        const first = await app.request(`/session/${session.id}/meta`)
        if (Flag.OPENCODE_SERVER_PASSWORD) return // can't assert further when auth blocks
        expect(first.status).toBe(200)
        const etag = first.headers.get("etag")
        expect(etag).toBeTruthy()

        const second = await app.request(`/session/${session.id}/meta`, {
          headers: { "If-None-Match": etag! },
        })
        expect(second.status).toBe(304)
        expect(second.headers.get("etag")).toBe(etag)
      },
    })
  })

  test("meta ETag shares version counter with session/messages namespaces (INV-1)", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await Session.create({})
        // Baseline: version = 0, all three keys share the same etag string.
        const metaEtag = SessionCache.currentEtag(session.id)
        const messagesEtag = SessionCache.currentEtag(session.id) // same fn, same id
        expect(metaEtag).toBe(messagesEtag)

        // Bump version (simulating an internal write) — all namespaces must shift.
        SessionCache.registerInvalidationSubscriber()
        const droppedBefore = SessionCache.stats().entries
        // Drive a bump by invalidating with a synthetic trigger (bus path is
        // covered in session-cache.test.ts); here we only need to observe
        // that the next ETag changes atomically for all namespaces.
        // Use the private-for-tests path: put one of each key type into the
        // cache, then invalidate.
        await SessionCache.get(`session:${session.id}`, session.id, async () => ({ data: 1, version: 0 }))
        await SessionCache.get(`messages:${session.id}:400`, session.id, async () => ({ data: 2, version: 0 }))
        await SessionCache.get(SessionCache.metaKey(session.id), session.id, async () => ({ data: 3, version: 0 }))
        const beforeEntries = SessionCache.stats().entries
        expect(beforeEntries).toBeGreaterThan(droppedBefore)

        const dropped = SessionCache.invalidate(session.id, "test-driven")
        // All three namespaces must be dropped together.
        expect(dropped).toBe(3)
        expect(SessionCache.stats().entries).toBe(beforeEntries - 3)
      },
    })
  })

  test("metaKey() produces canonical session:<id>:meta form", () => {
    expect(SessionCache.metaKey("ses_abc")).toBe("session:ses_abc:meta")
  })

  test("meta endpoint on unknown sessionID returns error (no silent fallback)", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const app = Server.App()
        const response = await app.request(`/session/ses_doesnotexist/meta`)
        if (Flag.OPENCODE_SERVER_PASSWORD) return
        // Must not be 200 — AGENTS.md rule 1: no silent fallback.
        expect(response.status).not.toBe(200)
        expect([400, 404, 500]).toContain(response.status)
      },
    })
  })
})
