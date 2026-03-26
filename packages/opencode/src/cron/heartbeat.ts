import fs from "fs/promises"
import { Log } from "../util/log"
import { Scheduler } from "../scheduler"
import { Instance } from "../project/instance"
import { CronStore } from "./store"
import { CronSession } from "./session"
import { ActiveHours } from "./active-hours"
import { SystemEvents } from "./system-events"
import { Schedule } from "./schedule"
import { RetryPolicy } from "./retry"
import { RunLog } from "./run-log"
import { CronDeliveryRouter } from "./delivery"
import { getCronPreloadedContext } from "./light-context"
import { SessionPrompt } from "../session/prompt"
import { TASKS_VIRTUAL_DIR } from "./virtual-project"
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

    // Ensure virtual tasks directory exists before first cron execution
    fs.mkdir(TASKS_VIRTUAL_DIR, { recursive: true }).catch((e) =>
      log.error("failed to create tasks virtual dir", { error: e }),
    )

    Scheduler.register({
      id: "cron:heartbeat",
      interval: intervalMs,
      scope: "global",
      run: () => tick(config),
    })
    log.info("registered", { intervalMs })
  }

  /**
   * Boot recovery — restore schedules from persisted CronStore state.
   *
   * For each enabled job:
   *   1. If nextRunAtMs is in the future → preserve (clean boot)
   *   2. If stale one-shot ("at") → disable with reason "expired_on_boot"
   *   3. If stale recurring ("every"/"cron") → skip-to-next future fire time
   *   4. If consecutiveErrors > 0 → overlay retry backoff on skip-to-next
   *
   * IDEF0 reference: A1 (Recover Scheduler State on Boot)
   * GRAFCET reference: opencode_a1_grafcet.json
   * Design decision: DD-13 (skip-to-next, no catchup)
   */
  export async function recoverSchedules(): Promise<RecoveryResult> {
    const jobs = await CronStore.listEnabled()
    const now = Date.now()
    const result: RecoveryResult = {
      total: jobs.length,
      clean: 0,
      skippedToNext: 0,
      disabledExpired: 0,
      backoffApplied: 0,
    }

    if (jobs.length === 0) {
      log.info("recovery: no enabled jobs")
      return result
    }

    for (const job of jobs) {
      try {
        await recoverJob(job, now, result)
      } catch (e) {
        log.error("recovery: job failed", { jobId: job.id, error: e })
      }
    }

    log.info("recovery complete", result)
    return result
  }

  export type RecoveryResult = {
    total: number
    clean: number
    skippedToNext: number
    disabledExpired: number
    backoffApplied: number
  }

  async function recoverJob(
    job: CronJob,
    nowMs: number,
    result: RecoveryResult,
  ): Promise<void> {
    const nextRun = job.state.nextRunAtMs

    // Clean boot: nextRunAtMs is in the future (or not set yet)
    if (!nextRun || nextRun > nowMs) {
      // If nextRunAtMs is not set, compute initial schedule
      if (!nextRun) {
        const nextFireMs = Schedule.computeNextRunAtMs(job.schedule, nowMs)
        if (nextFireMs) {
          await CronStore.updateState(job.id, { nextRunAtMs: nextFireMs })
        } else if (job.schedule.kind === "at") {
          // One-shot with no future fire time — disable
          await CronStore.update(job.id, {
            enabled: false,
            state: { nextRunAtMs: undefined },
          })
          result.disabledExpired++
          log.info("recovery: disabled expired one-shot (no nextRun)", { jobId: job.id })
          return
        }
      }
      result.clean++
      return
    }

    // Stale: nextRunAtMs is in the past
    if (job.schedule.kind === "at") {
      // One-shot expired — disable
      await CronStore.update(job.id, {
        enabled: false,
        state: { nextRunAtMs: undefined },
      })
      result.disabledExpired++
      log.info("recovery: disabled expired one-shot", { jobId: job.id, staleBy: nowMs - nextRun })
      return
    }

    // Recurring (every/cron): skip-to-next
    let nextFireMs = Schedule.computeNextRunAtMs(job.schedule, nowMs)
    if (!nextFireMs) {
      log.warn("recovery: no future fire time for recurring job", { jobId: job.id })
      return
    }

    // Overlay retry backoff if job has consecutive errors
    const errors = job.state.consecutiveErrors ?? 0
    if (errors > 0) {
      const backoff = RetryPolicy.backoffMs(errors)
      const backoffNext = nowMs + backoff
      nextFireMs = Math.max(nextFireMs, backoffNext)
      result.backoffApplied++
      log.info("recovery: backoff overlay", {
        jobId: job.id,
        consecutiveErrors: errors,
        backoffMs: backoff,
        nextRunAtMs: nextFireMs,
      })
    }

    await CronStore.updateState(job.id, { nextRunAtMs: nextFireMs })
    result.skippedToNext++
    log.info("recovery: skipped to next", {
      jobId: job.id,
      staleBy: nowMs - nextRun,
      nextRunAtMs: nextFireMs,
    })
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

    // Generate runId before execution so it's consistent across session, trigger, delivery, and log
    const runId = crypto.randomUUID()

    // Execute heartbeat / agent turn (GRAFCET step S5)
    // Wrap in Instance.provide() so sessions are scoped to the virtual tasks project
    const result = await Instance.provide({
      directory: TASKS_VIRTUAL_DIR,
      fn: () => executeJobRun(job, events, nowMs, runId),
    })

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

    // Log run (include sessionId for UI to read full AI response)
    const logEntry: CronRunLogEntry = {
      jobId: job.id,
      runId,
      startedAtMs: nowMs,
      completedAtMs: Date.now(),
      status: outcome.status,
      summary: outcome.summary,
      durationMs: outcome.durationMs,
      sessionId: result.sessionId,
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
    sessionId?: string
  }

  /**
   * Execute a job's payload.
   *
   * For agentTurn payloads:
   *   1. Resolve an isolated cron session via CronSession.resolve()
   *   2. Execute the AI turn via SessionPrompt.prompt()
   *   3. Return sessionId for run-log linkage (UI reads session messages for full AI response)
   */
  async function executeJobRun(
    job: CronJob,
    events: SystemEvents.SystemEvent[],
    nowMs: number,
    runId: string,
  ): Promise<JobRunResult> {
    if (job.payload.kind === "systemEvent") {
      // System event payloads: enqueue the text and check for actionable content
      const text = job.payload.text
      const hasContent = text.trim().length > 0 && text.trim() !== HEARTBEAT_OK_TOKEN
      return { hasActionableContent: hasContent, summary: text }
    }

    if (job.payload.kind === "agentTurn") {
      const eventContext = events.length > 0
        ? `\n\nSystem events since last run:\n${events.map((e) => `- ${e.text}`).join("\n")}`
        : ""
      const text = job.payload.message + eventContext

      if (!text.trim()) {
        return { hasActionableContent: false, summary: "Empty cron prompt" }
      }

      // 1. Resolve or create an isolated session for this run
      let sessionId: string | undefined
      try {
        const resolved = await CronSession.resolve({ job, runId })
        sessionId = resolved.sessionId
        log.info("cron session resolved", {
          jobId: job.id,
          runId,
          sessionId,
          isNew: resolved.isNew,
          sessionTarget: resolved.sessionTarget,
        })
      } catch (e) {
        log.error("cron session resolve failed", { jobId: job.id, runId, error: e })
        return {
          hasActionableContent: false,
          summary: `Session resolve failed: ${e instanceof Error ? e.message : String(e)}`,
        }
      }

      if (!sessionId) {
        log.error("cron session has no sessionId (main target not yet supported)", { jobId: job.id })
        return {
          hasActionableContent: false,
          summary: "Session target 'main' is not yet supported for cron execution",
        }
      }

      // 2. Execute the AI turn via SessionPrompt.prompt()
      try {
        const system = job.payload.lightContext
          ? getCronPreloadedContext({ jobName: job.name, jobId: job.id, runId })
          : undefined

        const result = await SessionPrompt.prompt({
          sessionID: sessionId,
          parts: [{ type: "text", text }],
          ...(system ? { system } : {}),
        })

        // Extract AI response text from the returned message parts
        let responseText = ""
        if (result?.parts) {
          for (const part of result.parts) {
            if (part.type === "text" && part.text) {
              responseText += part.text
            }
          }
        }
        const summary = responseText.trim().slice(0, 4000) || `Agent turn completed (no text output)`

        log.info("cron agent turn completed", { jobId: job.id, runId, sessionId })
        return {
          hasActionableContent: true,
          summary,
          sessionId,
        }
      } catch (e) {
        log.error("cron agent turn failed", { jobId: job.id, runId, sessionId, error: e })
        return {
          hasActionableContent: true,
          summary: `Agent turn failed: ${e instanceof Error ? e.message : String(e)}`,
          sessionId,
        }
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
