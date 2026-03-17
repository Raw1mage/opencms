import { Session } from "../session"
import { Storage } from "@/storage/storage"
import { Scheduler } from "../scheduler"
import { Log } from "../util/log"
import { CronSession } from "./session"
import { RunLog } from "./run-log"
import { CronStore } from "./store"

/**
 * Session retention reaper — prunes expired cron run-sessions (D.1.6).
 *
 * Runs on a scheduler interval (default every 30 minutes).
 * Prunes sessions older than `retentionMs` (default 24 hours).
 * Also triggers run-log JSONL pruning per job.
 *
 * IDEF0 reference: A14 (Enforce Session Retention Policy)
 * GRAFCET reference: opencode_a1_grafcet.json step S7
 */
export namespace CronRetention {
  const log = Log.create({ service: "cron.retention" })

  const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000 // 24 hours
  const CHECK_INTERVAL_MS = 30 * 60 * 1000 // 30 minutes

  /**
   * Register the retention reaper with the scheduler.
   * Should be called once during daemon initialization.
   */
  export function register(opts?: { retentionMs?: number; intervalMs?: number }) {
    const retentionMs = opts?.retentionMs ?? DEFAULT_RETENTION_MS
    const intervalMs = opts?.intervalMs ?? CHECK_INTERVAL_MS

    Scheduler.register({
      id: "cron:retention-reaper",
      interval: intervalMs,
      scope: "global",
      run: () => reap({ retentionMs }),
    })
    log.info("registered", { retentionMs, intervalMs })
  }

  /**
   * Run a single reap pass: find and remove expired cron sessions.
   */
  export async function reap(opts?: { retentionMs?: number }): Promise<ReapResult> {
    const retentionMs = opts?.retentionMs ?? DEFAULT_RETENTION_MS
    const now = Date.now()
    const result: ReapResult = { checked: 0, reaped: 0, errors: 0 }

    try {
      // Get all sessions and filter for cron-managed ones
      const sessions = await Session.list()
      const cronSessions = sessions.filter((s) => CronSession.isCronSession(s.title))

      result.checked = cronSessions.length

      for (const session of cronSessions) {
        if (CronSession.isExpired(session, retentionMs, now)) {
          try {
            await Storage.remove(["session", session.id])
            result.reaped++
            log.info("reaped session", { sessionId: session.id, title: session.title })
          } catch (e) {
            result.errors++
            log.error("reap session failed", { sessionId: session.id, error: e })
          }
        }
      }

      // Also prune run-logs for all known jobs
      try {
        const jobs = await CronStore.list()
        for (const job of jobs) {
          await RunLog.pruneForJob(job.id)
        }
      } catch (e) {
        log.error("run-log prune pass failed", { error: e })
      }

      log.info("reap complete", result)
    } catch (e) {
      log.error("reap failed", { error: e })
    }

    return result
  }

  export type ReapResult = {
    checked: number
    reaped: number
    errors: number
  }
}
