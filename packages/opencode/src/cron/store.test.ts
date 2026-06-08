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

  it("persists parentID round-trip (scheduled-subsession DD-5 lineage)", async () => {
    const job = await CronStore.create({
      name: "parented-job",
      enabled: true,
      schedule: { kind: "at", at: "2999-01-01T00:00:00Z" },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      parentID: "ses_parent123",
      payload: { kind: "agentTurn", message: "deferred work" },
    })

    expect(job.parentID).toBe("ses_parent123")

    const retrieved = await CronStore.get(job.id)
    expect(retrieved!.parentID).toBe("ses_parent123")
  })

  it("defaults parentID to undefined when not provided (headless cron)", async () => {
    const job = await CronStore.create({
      name: "orphan-job",
      enabled: true,
      schedule: { kind: "every", everyMs: 60000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "hi" },
    })
    expect(job.parentID).toBeUndefined()
  })

  it("creates a one-shot 'at' job and persists dormantSessionID (scheduled-subsession Phase 3)", async () => {
    const job = await CronStore.create({
      name: "one-shot",
      enabled: true,
      schedule: { kind: "at", at: "2999-01-01T15:00:00Z" },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      parentID: "ses_conv",
      payload: { kind: "agentTurn", message: "do the deferred thing", lightContext: true },
    })
    expect(job.schedule).toEqual({ kind: "at", at: "2999-01-01T15:00:00Z" })

    const updated = await CronStore.update(job.id, { dormantSessionID: "ses_dormant1" })
    expect(updated!.dormantSessionID).toBe("ses_dormant1")

    const retrieved = await CronStore.get(job.id)
    expect(retrieved!.dormantSessionID).toBe("ses_dormant1")
    expect(retrieved!.parentID).toBe("ses_conv")
  })

  it("one-shot 'at' fires at its timestamp even with wakeMode 'now' (scheduled-subsession e2e regression)", async () => {
    const atMs = Date.now() + 3_600_000 // 1 hour out
    const atIso = new Date(atMs).toISOString()
    const job = await CronStore.create({
      name: "at-respects-time",
      enabled: true,
      schedule: { kind: "at", at: atIso },
      sessionTarget: "isolated",
      wakeMode: "now", // must NOT collapse the `at` time to now
      payload: { kind: "agentTurn", message: "later", lightContext: true },
    })
    // nextRunAtMs must be the `at` time (~1h out), not ~now.
    expect(job.state.nextRunAtMs).toBeGreaterThan(Date.now() + 3_500_000)
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

  it("persists model selection in job state", async () => {
    const job = await CronStore.create({
      name: "model-persist-test",
      enabled: true,
      schedule: { kind: "every", everyMs: 60000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "hello", model: "github-copilot/gpt-5.4-mini", accountId: "acct-1" },
    })

    // Simulate rotation: persist a different model to state
    const updated = await CronStore.updateState(job.id, {
      lastModel: "openai/gpt-5.4",
      lastAccountId: "acct-2",
    })
    expect(updated!.state.lastModel).toBe("openai/gpt-5.4")
    expect(updated!.state.lastAccountId).toBe("acct-2")

    // Verify persistence across read
    const retrieved = await CronStore.get(job.id)
    expect(retrieved!.state.lastModel).toBe("openai/gpt-5.4")
    expect(retrieved!.state.lastAccountId).toBe("acct-2")
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
