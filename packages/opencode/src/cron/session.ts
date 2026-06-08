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

    // harness/scheduled-subsession DD-2: prefer the eagerly pre-created dormant subsession. Firing
    // the session the user has been watching/editing keeps lineage and avoids a duplicate orphan.
    // Releasing clears its `scheduled` marker so it is no longer dormant when the runloop runs.
    if (job.dormantSessionID) {
      const existing = await Session.get(job.dormantSessionID).catch(() => undefined)
      if (existing) {
        await release(existing.id)
        log.info("reusing dormant subsession", { jobId: job.id, runId, sessionId: existing.id })
        return { sessionId: existing.id, isNew: false, keyNamespace, sessionTarget: "isolated" }
      }
    }

    // Lazy fallback: create a fresh session scoped to this run.
    // When the job carries a parentID (originating conversation), create the run as a child
    // subsession for lineage rather than a detached orphan. harness/scheduled-subsession DD-5.
    log.info("creating isolated session", { jobId: job.id, runId, keyNamespace, parentID: job.parentID })
    const session = await Session.createNext({
      title: `[cron] ${job.name} — ${runId.slice(0, 8)}`,
      directory: Instance.directory,
      ...(job.parentID ? { parentID: job.parentID } : {}),
    })

    return {
      sessionId: session.id,
      isNew: true,
      keyNamespace,
      sessionTarget: "isolated",
    }
  }

  /**
   * Clear a session's dormant `scheduled` marker (harness/scheduled-subsession DD-2). Used to release
   * a dormant subsession for firing, or to settle it when a one-shot is missed/cancelled. Idempotent.
   */
  export async function release(sessionID: string): Promise<void> {
    await Session.update(sessionID, (draft) => {
      draft.scheduled = undefined
    }).catch((e) => log.warn("release scheduled marker failed", { sessionID, error: e }))
  }

  /**
   * Eagerly create a dormant subsession for a scheduled task (harness/scheduled-subsession DD-2).
   *
   * Creates a child subsession (parentID = originating conversation) and stamps the `scheduled`
   * marker so it is inert to every autonomous path until the heartbeat releases it. The deferred
   * prompt's source of truth remains the CronJob payload; this session is the visible/editable
   * carrier. Returns the new session id (to persist as job.dormantSessionID).
   */
  export async function createDormant(input: {
    jobId: string
    name: string
    parentID?: string
    fireAtMs: number
    now?: number
  }): Promise<string> {
    const now = input.now ?? Date.now()
    log.info("creating dormant scheduled subsession", { jobId: input.jobId, parentID: input.parentID })
    const session = await Session.createNext({
      title: `[scheduled] ${input.name}`,
      directory: Instance.directory,
      ...(input.parentID ? { parentID: input.parentID } : {}),
    })
    await Session.update(session.id, (draft) => {
      draft.scheduled = { jobId: input.jobId, fireAtMs: input.fireAtMs, createdAtMs: now }
    })
    return session.id
  }

  /**
   * Check if a session is a cron-managed session by its title prefix.
   */
  export function isCronSession(title: string | undefined): boolean {
    return (title?.startsWith("[cron]") || title?.startsWith("[scheduled]")) ?? false
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
