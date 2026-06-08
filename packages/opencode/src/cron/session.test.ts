import { describe, it, expect } from "bun:test"
import { Session } from "../session"
import { CronSession } from "./session"
import type { CronJob } from "./types"

/**
 * scheduled-subsession — CronSession dormant lifecycle (createDormant / resolve-reuse).
 * Session.createNext/get/update are mocked so these stay pure (no storage IO, XDG-safe).
 * Covers: child lineage (1.4), eager dormant marker (3.5), fire-time reuse + release (5.1).
 */
describe("CronSession dormant lifecycle", () => {
  it("createDormant makes a child subsession and stamps the scheduled marker (1.4 + 3.5)", async () => {
    const origCreate = Session.createNext
    const origUpdate = Session.update
    let createArg: any
    const draft: any = {}
    ;(Session as any).createNext = async (a: any) => {
      createArg = a
      return { id: "ses_new" }
    }
    ;(Session as any).update = async (_id: any, editor: any) => {
      editor(draft)
    }
    try {
      const sid = await CronSession.createDormant({
        jobId: "job1",
        name: "My Task",
        parentID: "ses_parent",
        fireAtMs: 999,
        now: 100,
      })
      expect(sid).toBe("ses_new")
      expect(createArg.parentID).toBe("ses_parent") // child lineage, not orphan
      expect(createArg.title).toContain("My Task")
      expect(draft.scheduled).toEqual({ jobId: "job1", fireAtMs: 999, createdAtMs: 100 }) // dormant marker
    } finally {
      ;(Session as any).createNext = origCreate
      ;(Session as any).update = origUpdate
    }
  })

  it("resolve reuses the pre-created dormant subsession and clears its scheduled marker (5.1)", async () => {
    const origGet = Session.get
    const origUpdate = Session.update
    let cleared = false
    ;(Session as any).get = async (id: string) => (id === "ses_dormant" ? { id: "ses_dormant", scheduled: { jobId: "j" } } : undefined)
    ;(Session as any).update = async (_id: string, editor: any) => {
      const d: any = { scheduled: { jobId: "j" } }
      editor(d)
      if (d.scheduled === undefined) cleared = true
    }
    try {
      const job = {
        id: "j",
        name: "t",
        sessionTarget: "isolated",
        dormantSessionID: "ses_dormant",
        schedule: { kind: "at", at: "2999-01-01T00:00:00Z" },
      } as unknown as CronJob
      const r = await CronSession.resolve({ job, runId: "run1" })
      expect(r.sessionId).toBe("ses_dormant")
      expect(r.isNew).toBe(false) // reused, not freshly created
      expect(cleared).toBe(true) // released: scheduled marker cleared so it can run
    } finally {
      ;(Session as any).get = origGet
      ;(Session as any).update = origUpdate
    }
  })

  it("resolve falls back to a fresh child when the dormant session is gone", async () => {
    const origGet = Session.get
    const origCreate = Session.createNext
    let createArg: any
    ;(Session as any).get = async () => undefined // dormant session vanished
    ;(Session as any).createNext = async (a: any) => {
      createArg = a
      return { id: "ses_fresh" }
    }
    try {
      const job = {
        id: "j",
        name: "t",
        sessionTarget: "isolated",
        dormantSessionID: "ses_missing",
        parentID: "ses_parent",
        schedule: { kind: "at", at: "2999-01-01T00:00:00Z" },
      } as unknown as CronJob
      const r = await CronSession.resolve({ job, runId: "run1" })
      expect(r.sessionId).toBe("ses_fresh")
      expect(r.isNew).toBe(true)
      expect(createArg.parentID).toBe("ses_parent") // still a child via lineage
    } finally {
      ;(Session as any).get = origGet
      ;(Session as any).createNext = origCreate
    }
  })
})
