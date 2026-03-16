import { describe, expect, it } from "bun:test"
import {
  CronJobSchema,
  CronStoreFileSchema,
  CronScheduleSchema,
  CronPayloadSchema,
  CronRunLogEntrySchema,
  cronSessionKey,
  mainSessionKey,
} from "./types"

describe("cron types", () => {
  describe("CronScheduleSchema", () => {
    it("validates 'at' schedule", () => {
      const result = CronScheduleSchema.safeParse({ kind: "at", at: "2026-03-17T10:00:00Z" })
      expect(result.success).toBe(true)
    })

    it("validates 'every' schedule", () => {
      const result = CronScheduleSchema.safeParse({ kind: "every", everyMs: 60000 })
      expect(result.success).toBe(true)
    })

    it("validates 'cron' schedule", () => {
      const result = CronScheduleSchema.safeParse({ kind: "cron", expr: "0 */6 * * *", tz: "Asia/Taipei" })
      expect(result.success).toBe(true)
    })

    it("rejects invalid kind", () => {
      const result = CronScheduleSchema.safeParse({ kind: "bogus" })
      expect(result.success).toBe(false)
    })
  })

  describe("CronPayloadSchema", () => {
    it("validates systemEvent payload", () => {
      const result = CronPayloadSchema.safeParse({ kind: "systemEvent", text: "heartbeat check" })
      expect(result.success).toBe(true)
    })

    it("validates agentTurn payload", () => {
      const result = CronPayloadSchema.safeParse({
        kind: "agentTurn",
        message: "run daily report",
        lightContext: true,
      })
      expect(result.success).toBe(true)
    })
  })

  describe("CronJobSchema", () => {
    it("validates a complete job", () => {
      const job = {
        id: "abc-123",
        name: "daily-report",
        enabled: true,
        createdAtMs: 1710000000000,
        updatedAtMs: 1710000000000,
        schedule: { kind: "cron", expr: "0 9 * * *" },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "generate report" },
        state: { consecutiveErrors: 0 },
      }
      const result = CronJobSchema.safeParse(job)
      expect(result.success).toBe(true)
    })

    it("validates job with delivery config", () => {
      const job = {
        id: "def-456",
        name: "webhook-job",
        enabled: true,
        createdAtMs: 1710000000000,
        updatedAtMs: 1710000000000,
        schedule: { kind: "every", everyMs: 3600000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "check health" },
        delivery: { mode: "webhook", webhookUrl: "https://example.com/hook" },
        state: {},
      }
      const result = CronJobSchema.safeParse(job)
      expect(result.success).toBe(true)
    })
  })

  describe("CronStoreFileSchema", () => {
    it("validates empty store", () => {
      const result = CronStoreFileSchema.safeParse({ version: 1, jobs: [] })
      expect(result.success).toBe(true)
    })

    it("rejects wrong version", () => {
      const result = CronStoreFileSchema.safeParse({ version: 2, jobs: [] })
      expect(result.success).toBe(false)
    })
  })

  describe("CronRunLogEntrySchema", () => {
    it("validates a log entry", () => {
      const entry = {
        jobId: "abc",
        runId: "run-1",
        startedAtMs: 1710000000000,
        completedAtMs: 1710000060000,
        status: "ok",
        durationMs: 60000,
      }
      const result = CronRunLogEntrySchema.safeParse(entry)
      expect(result.success).toBe(true)
    })
  })

  describe("session key helpers", () => {
    it("generates cron session key", () => {
      expect(cronSessionKey("job-1", "run-abc")).toBe("cron:job-1:run:run-abc")
    })

    it("generates main session key", () => {
      expect(mainSessionKey("agent-1")).toBe("agent:agent-1:main")
    })
  })
})
