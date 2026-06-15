import { describe, expect, test } from "bun:test"
import path from "path"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { SessionCache } from "../../src/server/session-cache"
import { Flag } from "../../src/flag/flag"
import { Log } from "../../src/util/log"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

// R2.8 — session.messages backward-compat + cursor pagination (R9).
// Covers TV-R9-S1..S6. Uses in-process app.request against Server.App() so
// the route handler exercises the same path as CMS/daemon callers.

async function seedMessages(sessionID: string, count: number): Promise<string[]> {
  const ids: string[] = []
  const baseTime = Date.now()
  for (let i = 0; i < count; i++) {
    const messageID = Identifier.ascending("message")
    await Session.updateMessage({
      id: messageID,
      sessionID,
      role: "user",
      time: { created: baseTime + i * 10 },
      agent: "build",
      model: {
        providerId: "opencode",
        modelID: "big-pickle",
      },
    })
    ids.push(messageID)
    // small delay so Identifier.ascending counters don't collide
    await new Promise((r) => setTimeout(r, 1))
  }
  return ids
}

describe("session.messages cursor pagination (R9)", () => {
  test("TV-R9-S1 — no cursor, no explicit limit → returns tweak-controlled tail (30 default)", async () => {
    SessionCache.resetForTesting()
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const app = Server.App()
        const session = await Session.create({ title: "cursor-tail" })
        await seedMessages(session.id, 50)

        const res = await app.request(`/session/${session.id}/message`)
        if (Flag.OPENCODE_SERVER_PASSWORD) {
          expect(res.status).toBe(401)
          return
        }
        expect(res.status).toBe(200)
        const body = (await res.json()) as Array<{ info: { id: string } }>
        expect(body.length).toBe(30)
      },
    })
  })

  test("TV-R9-S2 — cursor returns strictly older messages", async () => {
    SessionCache.resetForTesting()
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const app = Server.App()
        const session = await Session.create({ title: "cursor-older" })
        const ids = await seedMessages(session.id, 50)
        // ids are ascending → oldest-first. Pick id#20 as cursor.
        const cursor = ids[20]

        const res = await app.request(`/session/${session.id}/message?before=${encodeURIComponent(cursor)}&limit=10`)
        if (Flag.OPENCODE_SERVER_PASSWORD) return
        expect(res.status).toBe(200)
        const body = (await res.json()) as Array<{ info: { id: string } }>
        // Expect strictly older than cursor — the 10 messages before id[20]
        // in chronological (ascending) order = ids[10..19].
        expect(body.length).toBe(10)
        for (const m of body) {
          expect(m.info.id < cursor).toBe(true)
        }
        expect(body[0].info.id).toBe(ids[10])
        expect(body[body.length - 1].info.id).toBe(ids[19])
      },
    })
  })

  test("TV-R9-S3 — cursor at earliest → empty page (history complete)", async () => {
    SessionCache.resetForTesting()
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const app = Server.App()
        const session = await Session.create({ title: "cursor-empty" })
        const ids = await seedMessages(session.id, 10)
        const cursor = ids[0] // oldest

        const res = await app.request(`/session/${session.id}/message?before=${encodeURIComponent(cursor)}&limit=10`)
        if (Flag.OPENCODE_SERVER_PASSWORD) return
        expect(res.status).toBe(200)
        const body = (await res.json()) as Array<{ info: { id: string } }>
        expect(body.length).toBe(0)
      },
    })
  })

  test("TV-R9-S5 — legacy client (limit only, no cursor) still returns tail with explicit limit", async () => {
    SessionCache.resetForTesting()
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const app = Server.App()
        const session = await Session.create({ title: "cursor-legacy" })
        await seedMessages(session.id, 50)

        const res = await app.request(`/session/${session.id}/message?limit=20`)
        if (Flag.OPENCODE_SERVER_PASSWORD) return
        expect(res.status).toBe(200)
        const body = (await res.json()) as Array<{ info: { id: string } }>
        // Legacy contract: latest 20 (not a full hydrate).
        expect(body.length).toBe(20)
      },
    })
  })

  test("cursor returns at most `limit` entries even if more older exist", async () => {
    SessionCache.resetForTesting()
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const app = Server.App()
        const session = await Session.create({ title: "cursor-capped" })
        const ids = await seedMessages(session.id, 100)
        const cursor = ids[90]

        const res = await app.request(`/session/${session.id}/message?before=${encodeURIComponent(cursor)}&limit=15`)
        if (Flag.OPENCODE_SERVER_PASSWORD) return
        expect(res.status).toBe(200)
        const body = (await res.json()) as Array<{ info: { id: string } }>
        expect(body.length).toBe(15)
        // Results must all be strictly older than cursor.
        for (const m of body) {
          expect(m.info.id < cursor).toBe(true)
        }
      },
    })
  })
})
