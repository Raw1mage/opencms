import { z } from "zod"

/**
 * Cron job types for isolated job sessions (D.1).
 *
 * Benchmark reference: refs/openclaw/src/cron/types.ts
 * IDEF0 reference: A1 (Manage Isolated Job Sessions)
 */

// --- Schedule ---

export const CronScheduleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("at"), at: z.string() }),
  z.object({
    kind: z.literal("every"),
    everyMs: z.number().int().positive(),
    anchorMs: z.number().int().optional(),
  }),
  z.object({
    kind: z.literal("cron"),
    expr: z.string(),
    tz: z.string().optional(),
    staggerMs: z.number().int().nonnegative().optional(),
  }),
])
export type CronSchedule = z.infer<typeof CronScheduleSchema>

// --- Session target ---

export const CronSessionTargetSchema = z.enum(["main", "isolated"])
export type CronSessionTarget = z.infer<typeof CronSessionTargetSchema>

// --- Wake mode ---

export const CronWakeModeSchema = z.enum(["next-heartbeat", "now"])
export type CronWakeMode = z.infer<typeof CronWakeModeSchema>

// --- Delivery ---

export const CronDeliveryModeSchema = z.enum(["none", "announce", "webhook"])
export type CronDeliveryMode = z.infer<typeof CronDeliveryModeSchema>

export const CronDeliverySchema = z.object({
  mode: CronDeliveryModeSchema,
  webhookUrl: z.string().url().optional(),
  webhookBearerToken: z.string().optional(),
  announceSessionID: z.string().optional(),
  bestEffort: z.boolean().optional(),
})
export type CronDelivery = z.infer<typeof CronDeliverySchema>

// --- Run status ---

export const CronRunStatusSchema = z.enum(["ok", "error", "skipped"])
export type CronRunStatus = z.infer<typeof CronRunStatusSchema>

export const CronDeliveryStatusSchema = z.enum(["delivered", "not-delivered", "unknown", "not-requested"])
export type CronDeliveryStatus = z.infer<typeof CronDeliveryStatusSchema>

// --- Job state (runtime-tracked) ---

export const CronJobStateSchema = z.object({
  nextRunAtMs: z.number().optional(),
  runningAtMs: z.number().optional(),
  lastRunAtMs: z.number().optional(),
  lastRunStatus: CronRunStatusSchema.optional(),
  lastError: z.string().optional(),
  lastErrorReason: z.string().optional(),
  lastDurationMs: z.number().optional(),
  consecutiveErrors: z.number().int().nonnegative().optional(),
  lastFailureAlertAtMs: z.number().optional(),
  scheduleErrorCount: z.number().int().nonnegative().optional(),
  lastDeliveryStatus: CronDeliveryStatusSchema.optional(),
  lastDeliveryError: z.string().optional(),
})
export type CronJobState = z.infer<typeof CronJobStateSchema>

// --- Payload ---

export const CronPayloadSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("systemEvent"),
    text: z.string(),
  }),
  z.object({
    kind: z.literal("agentTurn"),
    message: z.string(),
    model: z.string().optional(),
    accountId: z.string().optional(),
    timeoutSeconds: z.number().int().positive().optional(),
    lightContext: z.boolean().optional(),
  }),
])
export type CronPayload = z.infer<typeof CronPayloadSchema>

// --- Failure alert ---

export const CronFailureAlertSchema = z.union([
  z.literal(false),
  z.object({
    after: z.number().int().positive().optional(),
    cooldownMs: z.number().int().nonnegative().optional(),
  }),
])
export type CronFailureAlert = z.infer<typeof CronFailureAlertSchema>

// --- Cron job ---

export const CronJobSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  enabled: z.boolean(),
  deleteAfterRun: z.boolean().optional(),
  createdAtMs: z.number(),
  updatedAtMs: z.number(),
  schedule: CronScheduleSchema,
  sessionTarget: CronSessionTargetSchema,
  wakeMode: CronWakeModeSchema,
  payload: CronPayloadSchema,
  delivery: CronDeliverySchema.optional(),
  failureAlert: CronFailureAlertSchema.optional(),
  state: CronJobStateSchema,
})
export type CronJob = z.infer<typeof CronJobSchema>

// --- Store file ---

export const CronStoreFileSchema = z.object({
  version: z.literal(1),
  jobs: z.array(CronJobSchema),
})
export type CronStoreFile = z.infer<typeof CronStoreFileSchema>

// --- Create / Patch ---

export type CronJobCreate = Omit<CronJob, "id" | "createdAtMs" | "updatedAtMs" | "state"> & {
  state?: Partial<CronJobState>
}

export type CronJobPatch = Partial<Omit<CronJob, "id" | "createdAtMs" | "state">> & {
  state?: Partial<CronJobState>
}

// --- Run outcome ---

export type CronRunOutcome = {
  status: CronRunStatus
  error?: string
  summary?: string
  sessionId?: string
  durationMs?: number
}

// --- Run log entry ---

export const CronRunLogEntrySchema = z.object({
  jobId: z.string(),
  runId: z.string(),
  startedAtMs: z.number(),
  completedAtMs: z.number().optional(),
  status: CronRunStatusSchema.optional(),
  error: z.string().optional(),
  summary: z.string().optional(),
  sessionId: z.string().optional(),
  durationMs: z.number().optional(),
  deliveryStatus: CronDeliveryStatusSchema.optional(),
})
export type CronRunLogEntry = z.infer<typeof CronRunLogEntrySchema>

// --- Session key helpers (A11: Scope Session Key Namespace) ---

export function cronSessionKey(jobId: string, runId: string): string {
  return `cron:${jobId}:run:${runId}`
}

export function mainSessionKey(agentId: string): string {
  return `agent:${agentId}:main`
}
