import { describe, expect, it } from "bun:test"
import { CronDeliveryRouter } from "./delivery"
import type { CronRunOutcome } from "./types"

describe("CronDeliveryRouter", () => {
  const baseOutcome: CronRunOutcome = {
    status: "ok",
    summary: "Report generated successfully",
    durationMs: 5000,
  }

  it("returns not-requested when delivery is undefined", async () => {
    const result = await CronDeliveryRouter.deliver({
      delivery: undefined,
      outcome: baseOutcome,
      jobName: "test",
      jobId: "j1",
      runId: "r1",
    })
    expect(result.status).toBe("not-requested")
  })

  it("returns not-requested when mode is none", async () => {
    const result = await CronDeliveryRouter.deliver({
      delivery: { mode: "none" },
      outcome: baseOutcome,
      jobName: "test",
      jobId: "j1",
      runId: "r1",
    })
    expect(result.status).toBe("not-requested")
  })

  it("delivers announce mode", async () => {
    const result = await CronDeliveryRouter.deliver({
      delivery: { mode: "announce", announceSessionID: "ses_abc" },
      outcome: baseOutcome,
      jobName: "daily-report",
      jobId: "j1",
      runId: "r1",
    })
    expect(result.status).toBe("delivered")
  })

  it("fails webhook when no URL configured", async () => {
    const result = await CronDeliveryRouter.deliver({
      delivery: { mode: "webhook" },
      outcome: baseOutcome,
      jobName: "test",
      jobId: "j1",
      runId: "r1",
    })
    expect(result.status).toBe("not-delivered")
    expect(result.error).toContain("no webhook URL")
  })

  it("handles error outcome formatting in announce", async () => {
    const errorOutcome: CronRunOutcome = {
      status: "error",
      error: "timeout after 30s",
      durationMs: 30000,
    }
    const result = await CronDeliveryRouter.deliver({
      delivery: { mode: "announce" },
      outcome: errorOutcome,
      jobName: "failing-job",
      jobId: "j2",
      runId: "r2",
    })
    expect(result.status).toBe("delivered")
  })
})
