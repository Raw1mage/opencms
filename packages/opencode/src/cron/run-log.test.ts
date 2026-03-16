import { describe, expect, it, beforeEach } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "../global"
import { RunLog } from "./run-log"
import type { CronRunLogEntry } from "./types"

const runsDir = path.join(Global.Path.config, "cron", "runs")

describe("RunLog", () => {
  beforeEach(async () => {
    // Clean all test log files
    await fs.rm(runsDir, { recursive: true, force: true }).catch(() => {})
  })

  function makeEntry(jobId: string, runId: string, status: "ok" | "error" = "ok"): CronRunLogEntry {
    return {
      jobId,
      runId,
      startedAtMs: Date.now(),
      completedAtMs: Date.now() + 1000,
      status,
      durationMs: 1000,
    }
  }

  it("returns empty array for non-existent log", async () => {
    const entries = await RunLog.read("non-existent")
    expect(entries).toEqual([])
  })

  it("appends and reads entries", async () => {
    await RunLog.append(makeEntry("job-1", "run-1"))
    await RunLog.append(makeEntry("job-1", "run-2"))

    const entries = await RunLog.read("job-1")
    expect(entries.length).toBe(2)
    expect(entries[0].runId).toBe("run-1")
    expect(entries[1].runId).toBe("run-2")
  })

  it("reads with limit (returns most recent)", async () => {
    for (let i = 0; i < 5; i++) {
      await RunLog.append(makeEntry("job-2", `run-${i}`))
    }

    const entries = await RunLog.read("job-2", 2)
    expect(entries.length).toBe(2)
    expect(entries[0].runId).toBe("run-3")
    expect(entries[1].runId).toBe("run-4")
  })

  it("removes log for a job", async () => {
    await RunLog.append(makeEntry("job-3", "run-1"))
    await RunLog.removeForJob("job-3")

    const entries = await RunLog.read("job-3")
    expect(entries).toEqual([])
  })

  it("isolates logs per job", async () => {
    await RunLog.append(makeEntry("job-a", "run-1"))
    await RunLog.append(makeEntry("job-b", "run-2"))

    const a = await RunLog.read("job-a")
    const b = await RunLog.read("job-b")
    expect(a.length).toBe(1)
    expect(b.length).toBe(1)
    expect(a[0].runId).toBe("run-1")
    expect(b[0].runId).toBe("run-2")
  })
})
