import { Log } from "../util/log"
import { Scheduler } from "../scheduler"
import { CronStore } from "./store"
import { CronSession } from "./session"
import { ActiveHours } from "./active-hours"
import { SystemEvents } from "./system-events"
import { Schedule } from "./schedule"
import { RunLog } from "./run-log"
import { CronDeliveryRouter } from "./delivery"
import { buildCronTrigger } from "../session/trigger"
import type { CronJob, CronRunLogEntry, CronRunOutcome } from "./types"

/**
 * Heartbeat supervision — the central heartbeat/wakeup loop (D.2.5-D.2.7).
 *
 * On each interval tick:
 *   1. Check active hours gate
 *   2. Evaluate pending system events
 *   3. Execute heartbeat checklist (HEARTBEAT.md)
 *   4. Suppress if HEARTBEAT_OK (no actionable content)
 *   5. Deliver result if actionable
 *
 * IDEF0 reference: A2 (Schedule Trigger Evaluation)
 * GRAFCET reference: opencode_a2_grafcet.json (full state machine)
 * Design decision: DD-9 (30min default interval)
 * Benchmark: refs/openclaw/src/infra/heartbeat-runner.ts
 */
export namespace Heartbeat {
  const log = Log.create({ service: "cron.heartbeat" })

  const HEARTBEAT_OK_TOKEN = "HEARTBEAT_OK"
  const DEFAULT_INTERVAL_MS = 30 * 60 * 1000 // 30 minutes (DD-9)

  export type HeartbeatConfig = {
    enabled: boolean
    intervalMs: number
    activeHours?: ActiveHours.Config
    suppressOnOk: boolean
  }

  export type HeartbeatResult = {
    status: "executed" | "suppressed" | "outside_hours" | "skipped"
    hasActionableContent: boolean
    eventsProcessed: number
    suppressionReason?: string
  }

  /**
   * Register the heartbeat scheduler.
   * Should be called once during daemon initialization.
   */
  export function register(config?: Partial<HeartbeatConfig>) {
    const intervalMs = config?.intervalMs ?? DEFAULT_INTERVAL_MS
    const enabled = config?.enabled ?? true

    if (!enabled) {
      log.info("heartbeat disabled")
      return
    }

    Scheduler.register({
      id: "cron:heartbeat",
      interval: intervalMs,
      scope: "global",
      run: () => tick(config),
    })
    log.info("registered", { intervalMs })
  }

  /**
   * Single heartbeat tick — evaluates all enabled jobs.
   */
  export async function tick(config?: Partial<HeartbeatConfig>): Promise<void> {
    const jobs = await CronStore.listEnabled()
    const now = Date.now()

    for (const job of jobs) {
      try {
        await evaluateJob(job, now, config)
      } catch (e) {
        log.error("job evaluation failed", { jobId: job.id, error: e })
      }
    }
  }

  /**
   * Evaluate a single job: check schedule, active hours, fire if due.
   */
  async function evaluateJob(
    job: CronJob,
    nowMs: number,
    config?: Partial<HeartbeatConfig>,
  ): Promise<HeartbeatResult> {
    // Check if job is due to fire
    const nextRun = job.state.nextRunAtMs
    if (nextRun && nextRun > nowMs) {
      return { status: "skipped", hasActionableContent: false, eventsProcessed: 0 }
    }

    // Check active hours gate (GRAFCET step S1)
    const hoursGate = ActiveHours.check(config?.activeHours, nowMs)
    if (!hoursGate.allowed) {
      // Update next run to after active hours window opens
      await CronStore.updateState(job.id, { nextRunAtMs: hoursGate.nextEligibleMs })
      return {
        status: "outside_hours",
        hasActionableContent: false,
        eventsProcessed: 0,
        suppressionReason: "outside active hours",
      }
    }

    // Evaluate system events (GRAFCET steps S2-S3)
    const sessionKey = `cron:${job.id}`
    const events = SystemEvents.drain(sessionKey)

    // Execute based on wake mode
    if (job.wakeMode === "next-heartbeat" && events.length === 0) {
      // No events and not scheduled yet — check cron schedule
      const nextFireMs = Schedule.computeNextRunAtMs(job.schedule, nowMs)
      if (nextFireMs) {
        const stagger = Schedule.computeStaggerMs(job.schedule, job.id)
        await CronStore.updateState(job.id, { nextRunAtMs: nextFireMs + stagger })
      }
      return { status: "skipped", hasActionableContent: false, eventsProcessed: 0 }
    }

    // Execute heartbeat / agent turn (GRAFCET step S5)
    const result = await executeJobRun(job, events, nowMs)

    // HEARTBEAT_OK suppression (D.2.5, GRAFCET step S7)
    if (config?.suppressOnOk !== false && !result.hasActionableContent) {
      log.info("HEARTBEAT_OK suppression", { jobId: job.id })
      // Update schedule for next run
      const nextFireMs = Schedule.computeNextRunAtMs(job.schedule, nowMs)
      if (nextFireMs) {
        const stagger = Schedule.computeStaggerMs(job.schedule, job.id)
        await CronStore.updateState(job.id, {
          nextRunAtMs: nextFireMs + stagger,
          lastRunAtMs: nowMs,
          lastRunStatus: "ok",
        })
      }
      return {
        status: "suppressed",
        hasActionableContent: false,
        eventsProcessed: events.length,
        suppressionReason: HEARTBEAT_OK_TOKEN,
      }
    }

    // Deliver result (GRAFCET step S6)
    const runId = crypto.randomUUID()
    const outcome: CronRunOutcome = {
      status: result.hasActionableContent ? "ok" : "skipped",
      summary: result.summary,
      durationMs: Date.now() - nowMs,
    }

    await CronDeliveryRouter.deliver({
      delivery: job.delivery,
      outcome,
      jobName: job.name,
      jobId: job.id,
      runId,
    })

    // Log run
    const logEntry: CronRunLogEntry = {
      jobId: job.id,
      runId,
      startedAtMs: nowMs,
      completedAtMs: Date.now(),
      status: outcome.status,
      summary: outcome.summary,
      durationMs: outcome.durationMs,
    }
    await RunLog.append(logEntry)

    // Update state and schedule next run
    const nextFireMs = Schedule.computeNextRunAtMs(job.schedule, nowMs)
    const stagger = nextFireMs ? Schedule.computeStaggerMs(job.schedule, job.id) : 0
    await CronStore.updateState(job.id, {
      nextRunAtMs: nextFireMs ? nextFireMs + stagger : undefined,
      lastRunAtMs: nowMs,
      lastRunStatus: outcome.status,
      consecutiveErrors: outcome.status === "error" ? (job.state.consecutiveErrors ?? 0) + 1 : 0,
    })

    // Handle deleteAfterRun
    if (job.deleteAfterRun) {
      await CronStore.remove(job.id)
      log.info("deleted after run", { jobId: job.id })
    }

    return {
      status: "executed",
      hasActionableContent: result.hasActionableContent,
      eventsProcessed: events.length,
    }
  }

  type JobRunResult = {
    hasActionableContent: boolean
    summary?: string
  }

  /**
   * Execute a job's payload. For now, builds a cron trigger.
   * The actual agent turn execution is delegated to the trigger/queue system.
   */
  async function executeJobRun(
    job: CronJob,
    events: SystemEvents.SystemEvent[],
    nowMs: number,
  ): Promise<JobRunResult> {
    const runId = crypto.randomUUID()

    if (job.payload.kind === "systemEvent") {
      // System event payloads: enqueue the text and check for actionable content
      const text = job.payload.text
      const hasContent = text.trim().length > 0 && text.trim() !== HEARTBEAT_OK_TOKEN
      return { hasActionableContent: hasContent, summary: text }
    }

    if (job.payload.kind === "agentTurn") {
      // Build a cron trigger for the queue system to pick up
      const eventContext = events.length > 0
        ? `\n\nSystem events since last run:\n${events.map((e) => `- ${e.text}`).join("\n")}`
        : ""

      const trigger = buildCronTrigger({
        source: job.wakeMode === "now" ? "scheduled" : "heartbeat",
        text: job.payload.message + eventContext,
        jobId: job.id,
        runId,
        lightContext: job.payload.lightContext,
        priority: "background",
      })

      // The trigger is built — in a full system this would be enqueued.
      // For now, return that we have actionable content.
      const hasContent = job.payload.message.trim().length > 0
      return {
        hasActionableContent: hasContent,
        summary: `Agent turn triggered: ${job.payload.message.slice(0, 100)}`,
      }
    }

    return { hasActionableContent: false }
  }

  /**
   * Check if a string is a HEARTBEAT_OK token.
   */
  export function isHeartbeatOk(text: string): boolean {
    return text.trim() === HEARTBEAT_OK_TOKEN
  }

  /**
   * Strip HEARTBEAT_OK tokens from a response.
   */
  export function stripHeartbeatToken(text: string): string {
    return text.replace(new RegExp(`\\b${HEARTBEAT_OK_TOKEN}\\b`, "g"), "").trim()
  }
}
