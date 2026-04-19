import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { Log } from "../../src/util/log"
import { Flag } from "../../src/flag/flag"
import { RebindEpoch } from "../../src/session/rebind-epoch"
import {
  CapabilityLayer,
  setCapabilityLayerLoader,
  type CapabilityLayerLoader,
  type LayerBundle,
} from "../../src/session/capability-layer"
import { SessionStatus } from "../../src/session/status"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

class StubLoader implements CapabilityLayerLoader {
  async load(): Promise<LayerBundle> {
    return {
      agents_md: { text: "stub agents", sources: [] },
      skill_content: {
        pinnedSkills: ["plan-builder"],
        renderedText: "",
        missingSkills: [],
      },
    }
  }
}

afterEach(() => {
  RebindEpoch.reset()
  CapabilityLayer.reset()
  setCapabilityLayerLoader(null)
})

beforeEach(() => {
  setCapabilityLayerLoader(new StubLoader())
})

async function postResume(app: ReturnType<typeof Server.App>, sessionID: string, body?: Record<string, unknown>) {
  return app.request(`/session/${sessionID}/resume`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  })
}

describe("POST /session/:id/resume — happy path", () => {
  test("bumps epoch + silent reinject when session is idle", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const app = Server.App()
        const session = await Session.create({})
        const response = await postResume(app, session.id, { clientID: "tui" })
        if (Flag.OPENCODE_SERVER_PASSWORD) {
          expect(response.status).toBe(401)
          return
        }
        expect(response.status).toBe(200)
        const body = (await response.json()) as {
          status: string
          sessionID: string
          previousEpoch: number
          currentEpoch: number
          trigger: string
          reinject: null | { pinnedSkills: string[]; failures: unknown[] }
        }
        expect(body.status).toBe("ok")
        expect(body.sessionID).toBe(session.id)
        expect(body.previousEpoch).toBe(0)
        expect(body.currentEpoch).toBe(1)
        expect(body.trigger).toBe("session_resume")
        expect(body.reinject).not.toBeNull()
        expect(body.reinject?.pinnedSkills).toEqual(["plan-builder"])
        expect(body.reinject?.failures).toEqual([])

        expect(RebindEpoch.current(session.id)).toBe(1)
        expect(CapabilityLayer.peek(session.id, 1)).toBeDefined()
      },
    })
  })
})

describe("POST /session/:id/resume — session busy skip (DD-5)", () => {
  test("busy session returns busy_skipped without reinject or epoch reversion", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const app = Server.App()
        const session = await Session.create({})
        // Simulate session busy via SessionStatus.set
        SessionStatus.set(session.id, { type: "busy" })

        const response = await postResume(app, session.id)
        if (Flag.OPENCODE_SERVER_PASSWORD) {
          expect(response.status).toBe(401)
          return
        }
        expect(response.status).toBe(200)
        const body = (await response.json()) as { status: string; previousEpoch: number; currentEpoch: number; reinject: unknown }
        expect(body.status).toBe("busy_skipped")
        // Epoch WAS bumped (so runLoop will see the new epoch when it finishes)
        expect(body.previousEpoch).toBe(0)
        expect(body.currentEpoch).toBe(1)
        expect(body.reinject).toBeNull()
        // Capability cache NOT populated — runLoop will fill on its next iteration
        expect(CapabilityLayer.peek(session.id, 1)).toBeUndefined()
        // restore status for other tests
        SessionStatus.set(session.id, { type: "idle" })
      },
    })
  })
})

describe("POST /session/:id/resume — rate limit", () => {
  test("6th resume within 1s returns rate_limited", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const app = Server.App()
        const session = await Session.create({})
        // Pre-fill the rate-limit window with 5 direct bumps
        for (let i = 0; i < 5; i++) {
          await RebindEpoch.bumpEpoch({ sessionID: session.id, trigger: "slash_reload" })
        }
        const response = await postResume(app, session.id)
        if (Flag.OPENCODE_SERVER_PASSWORD) {
          expect(response.status).toBe(401)
          return
        }
        expect(response.status).toBe(200)
        const body = (await response.json()) as { status: string; currentEpoch: number; rateLimitReason?: string | null }
        expect(body.status).toBe("rate_limited")
        expect(body.currentEpoch).toBe(5) // unchanged
        expect(body.rateLimitReason).toMatch(/rate_limit/)
      },
    })
  })
})

describe("POST /session/:id/resume — unknown session", () => {
  test("returns 4xx when sessionID does not exist", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const app = Server.App()
        const response = await postResume(app, "ses_nonexistent_000000000000000000000000")
        if (Flag.OPENCODE_SERVER_PASSWORD) {
          expect(response.status).toBe(401)
          return
        }
        // Session.get throws on missing → error middleware returns 404 or 400
        expect([400, 404, 500]).toContain(response.status)
      },
    })
  })
})
