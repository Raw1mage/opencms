import { describe, expect, it, beforeEach } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "../global"
import { CronStore } from "./store"

/**
 * CronStore tests — uses the real Global.Path.config since it's
 * resolved at module load time. We clean up the store file between tests.
 */
const cronDir = path.join(Global.Path.config, "cron")
const storePath = path.join(cronDir, "jobs.json")

describe("CronStore", () => {
  beforeEach(async () => {
    // Ensure clean state for each test
    await fs.unlink(storePath).catch(() => {})
  })

  it("returns empty list when no store file exists", async () => {
    const jobs = await CronStore.list()
    expect(jobs).toEqual([])
  })

  it("creates a job and retrieves it", async () => {
    const job = await CronStore.create({
      name: "test-job",
      enabled: true,
      schedule: { kind: "every", everyMs: 60000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "hello" },
    })

    expect(job.id).toBeDefined()
    expect(job.name).toBe("test-job")
    expect(job.enabled).toBe(true)
    expect(job.state.consecutiveErrors).toBe(0)
    expect(job.state.nextRunAtMs).toBeGreaterThan(Date.now() - 5_000)

    const retrieved = await CronStore.get(job.id)
    expect(retrieved).toBeDefined()
    expect(retrieved!.id).toBe(job.id)
  })

  it("updates a job", async () => {
    const job = await CronStore.create({
      name: "update-test",
      enabled: true,
      schedule: { kind: "every", everyMs: 60000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "check" },
    })

    const updated = await CronStore.update(job.id, { enabled: false })
    expect(updated).toBeDefined()
    expect(updated!.enabled).toBe(false)
    expect(updated!.name).toBe("update-test")
    expect(updated!.state.nextRunAtMs).toBeUndefined()
  })

  it("seeds immediate nextRunAtMs for wakeMode now", async () => {
    const before = Date.now()
    const job = await CronStore.create({
      name: "immediate-job",
      enabled: true,
      schedule: { kind: "every", everyMs: 60000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "hello" },
    })

    expect(job.state.nextRunAtMs).toBeDefined()
    expect(job.state.nextRunAtMs!).toBeLessThanOrEqual(before)
  })

  it("recomputes nextRunAtMs when schedule changes", async () => {
    const job = await CronStore.create({
      name: "reschedule-job",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "a" },
    })

    const updated = await CronStore.update(job.id, {
      schedule: { kind: "every", everyMs: 5 * 60_000 },
    })

    expect(updated).toBeDefined()
    expect(updated!.state.nextRunAtMs).toBeGreaterThan(Date.now())
  })

  it("updates job state", async () => {
    const job = await CronStore.create({
      name: "state-test",
      enabled: true,
      schedule: { kind: "cron", expr: "0 * * * *" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "run" },
    })

    const updated = await CronStore.updateState(job.id, {
      lastRunStatus: "ok",
      lastRunAtMs: Date.now(),
      consecutiveErrors: 0,
    })
    expect(updated!.state.lastRunStatus).toBe("ok")
    expect(updated!.state.consecutiveErrors).toBe(0)
  })

  it("removes a job", async () => {
    const job = await CronStore.create({
      name: "remove-test",
      enabled: true,
      schedule: { kind: "every", everyMs: 1000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "test" },
    })

    const removed = await CronStore.remove(job.id)
    expect(removed).toBe(true)

    const after = await CronStore.get(job.id)
    expect(after).toBeUndefined()
  })

  it("remove returns false for non-existent job", async () => {
    const removed = await CronStore.remove("non-existent-id")
    expect(removed).toBe(false)
  })

  it("lists only enabled jobs", async () => {
    await CronStore.create({
      name: "enabled-job",
      enabled: true,
      schedule: { kind: "every", everyMs: 60000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "a" },
    })
    await CronStore.create({
      name: "disabled-job",
      enabled: false,
      schedule: { kind: "every", everyMs: 60000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "b" },
    })

    const enabled = await CronStore.listEnabled()
    expect(enabled.length).toBe(1)
    expect(enabled[0].name).toBe("enabled-job")
  })
})
