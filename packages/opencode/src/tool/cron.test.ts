import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "../global"
import { CronStore } from "../cron/store"
import { CronSession } from "../cron/session"
import { CronUpdateTool, CronCancelTool, CronStatusTool } from "./cron"

/**
 * scheduled-subsession Phase 4 — cron family tool logic (cron_update / cron_cancel / cron_status).
 * Uses the real CronStore (file at Global.Path.config/cron); CronSession.release is mocked so we
 * don't need the full session/Instance harness.
 */
const storePath = path.join(Global.Path.config, "cron", "jobs.json")

function ctx() {
  return {
    sessionID: "ses_test",
    messageID: "msg_test",
    agent: "main",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => undefined,
    ask: async () => undefined,
  } as any
}

async function makeAtJob(enabled = true, atOffsetMs = 3_600_000) {
  return CronStore.create({
    name: "edit-target",
    enabled,
    schedule: { kind: "at", at: new Date(Date.now() + atOffsetMs).toISOString() },
    sessionTarget: "isolated",
    wakeMode: "now",
    parentID: "ses_parent",
    dormantSessionID: "ses_dormant",
    payload: { kind: "agentTurn", message: "original", lightContext: true },
  })
}

describe("cron family tools", () => {
  beforeEach(async () => {
    await fs.unlink(storePath).catch(() => {})
  })

  it("cron_update rejects an unknown id", async () => {
    const tool = await CronUpdateTool.init()
    const r = await tool.execute({ id: "nope" }, ctx())
    expect(r.metadata.code).toBe("SCHED_TASK_NOT_FOUND")
  })

  it("cron_update rejects when neither schedule nor prompt is given", async () => {
    const job = await makeAtJob()
    const tool = await CronUpdateTool.init()
    const r = await tool.execute({ id: job.id }, ctx())
    expect(r.metadata.code).toBe("SCHED_UPDATE_EMPTY")
  })

  it("cron_update changes prompt and reschedules before fire", async () => {
    const job = await makeAtJob()
    const tool = await CronUpdateTool.init()
    const newAt = new Date(Date.now() + 7_200_000).toISOString()
    const r = await tool.execute({ id: job.id, prompt: "new instruction", schedule: { kind: "at", at: newAt } }, ctx())
    expect(r.metadata.jobId).toBe(job.id)
    const updated = await CronStore.get(job.id)
    expect(updated!.payload.kind === "agentTurn" && updated!.payload.message).toBe("new instruction")
    expect(updated!.schedule).toEqual({ kind: "at", at: newAt })
    // next run recomputed to the new `at` time (~2h out)
    expect(updated!.state.nextRunAtMs).toBeGreaterThan(Date.now() + 7_000_000)
  })

  it("cron_update rejects editing a one-shot that already settled (after fire)", async () => {
    const job = await makeAtJob(false /* settled */)
    const tool = await CronUpdateTool.init()
    const r = await tool.execute({ id: job.id, prompt: "too late" }, ctx())
    expect(r.metadata.code).toBe("SCHED_EDIT_AFTER_FIRE")
  })

  it("cron_cancel removes the job and releases its dormant subsession", async () => {
    const originalRelease = CronSession.release
    const released: string[] = []
    ;(CronSession as any).release = async (sid: string) => {
      released.push(sid)
    }
    try {
      const job = await makeAtJob()
      const tool = await CronCancelTool.init()
      const r = await tool.execute({ id: job.id }, ctx())
      expect(r.metadata.found).toBe(true)
      expect(await CronStore.get(job.id)).toBeUndefined()
      expect(released).toContain("ses_dormant")
    } finally {
      ;(CronSession as any).release = originalRelease
    }
  })

  it("cron_cancel reports not-found for an unknown id", async () => {
    const tool = await CronCancelTool.init()
    const r = await tool.execute({ id: "nope" }, ctx())
    expect(r.metadata.found).toBe(false)
  })

  it("cron_status reports a task with its schedule and subsession", async () => {
    const job = await makeAtJob()
    const tool = await CronStatusTool.init()
    const r = await tool.execute({ id: job.id }, ctx())
    expect(r.metadata.count).toBe(1)
    expect(r.output).toContain(job.id)
    expect(r.output).toContain("ses_dormant")
  })
})
