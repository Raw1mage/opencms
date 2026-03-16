import { Session } from "../session"
import { Instance } from "../project/instance"
import { Log } from "../util/log"
import { cronSessionKey, type CronJob, type CronSessionTarget } from "./types"

/**
 * Isolated cron session factory (D.1.2).
 *
 * Resolves or creates a session for a cron job run based on the job's
 * sessionTarget setting:
 *   - "isolated": creates a fresh session per run with scoped key namespace
 *   - "main": reuses the current main session
 *
 * IDEF0 reference: A11 (Scope Session Key Namespace), A12 (Bootstrap Lightweight Context)
 * GRAFCET reference: opencode_a1_grafcet.json steps S2-S4
 * Benchmark: refs/openclaw/src/cron/isolated-agent/session.ts (resolveCronSession)
 */
export namespace CronSession {
  const log = Log.create({ service: "cron.session" })

  export type ResolvedSession = {
    sessionId: string
    isNew: boolean
    keyNamespace: string
    sessionTarget: CronSessionTarget
  }

  /**
   * Resolve or create a session for a cron job run.
   *
   * For isolated sessions: creates a new session with `cron:<jobId>:run:<runId>` key namespace.
   * For main sessions: returns the current instance session (no new session created).
   */
  export async function resolve(input: {
    job: CronJob
    runId: string
  }): Promise<ResolvedSession> {
    const { job, runId } = input
    const keyNamespace = cronSessionKey(job.id, runId)

    if (job.sessionTarget === "main") {
      log.info("resolve main session", { jobId: job.id })
      return {
        sessionId: "", // caller must resolve to active main session
        isNew: false,
        keyNamespace: `agent:main`,
        sessionTarget: "main",
      }
    }

    // Isolated session: create a fresh session scoped to this run
    log.info("creating isolated session", { jobId: job.id, runId, keyNamespace })
    const session = await Session.createNext({
      title: `[cron] ${job.name} — ${runId.slice(0, 8)}`,
      directory: Instance.directory,
    })

    return {
      sessionId: session.id,
      isNew: true,
      keyNamespace,
      sessionTarget: "isolated",
    }
  }

  /**
   * Check if a session is a cron-managed session by its title prefix.
   */
  export function isCronSession(title: string | undefined): boolean {
    return title?.startsWith("[cron]") ?? false
  }

  /**
   * Check if a session is expired based on retention policy.
   */
  export function isExpired(
    session: { time: { created: number; updated: number } },
    retentionMs: number,
    now: number = Date.now(),
  ): boolean {
    return now - session.time.updated > retentionMs
  }
}
