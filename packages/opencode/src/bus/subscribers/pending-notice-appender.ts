/**
 * pending-notice-appender (responsive-orchestrator R2 / DD-3)
 *
 * Consumes `task.completed` Bus events from the task tool's watcher and
 * appends a PendingSubagentNotice to the parent session's info.json#
 * pendingSubagentNotices array. Prompt assembly later drains the array
 * by rendering each notice as a one-line system-prompt addendum.
 *
 * Idempotent: if a notice for the same jobId already exists, latest wins
 * (prevents double-delivery on Bus replay).
 *
 * Never throws: if the parent session is gone, logs a structured warning
 * and drops the notice — subagent's own session remains browsable.
 */

import { Bus } from "../index"
import { TaskCompletedEvent } from "@/tool/task"
import { Session } from "@/session"
import { MessageV2 } from "@/session/message-v2"
import { Instance } from "@/project/instance"
import { Log } from "@/util/log"
import {
  enqueueAutonomousContinue,
  resumePendingContinuations,
  getPendingContinuation,
} from "@/session/workflow-runner"

const log = Log.create({ service: "task.notice" })

// bugfix/subagent-double-turn DD-3: bound the per-jobId auto-resume ledger so it
// never grows unbounded across a long-lived session. 64 >> realistic in-flight
// subagent fan-out per session; FIFO-evict the oldest when exceeded.
const MAX_RESUMED_JOBIDS = 64

let registered = false

export function registerPendingNoticeAppenderSubscriber() {
  if (registered) return
  registered = true

  Bus.subscribeGlobal(TaskCompletedEvent.type, 0, async (event) => {
    const p = event.properties
    const directory = event.context?.directory

    const run = async () => {
      try {
        const parent = await Session.get(p.parentSessionID).catch(() => undefined)
        if (!parent) {
          log.warn("WATCHER_PARENT_GONE: parent session not found; dropping notice", {
            jobId: p.jobId,
            parentSessionID: p.parentSessionID,
            childSessionID: p.childSessionID,
            status: p.status,
          })
          return
        }

        const notice: MessageV2.PendingSubagentNotice = {
          jobId: p.jobId,
          childSessionID: p.childSessionID,
          status: p.status,
          // Cast finish string to the schema enum; unknown values pass
          // through zod.enum only at parse time — we store what we got.
          finish: p.finish as MessageV2.PendingSubagentNotice["finish"],
          elapsedMs: p.elapsedMs,
          at: new Date().toISOString(),
          errorDetail: p.errorDetail,
          rotateHint: p.rotateHint,
          cancelReason: p.cancelReason,
          result: p.result,
        }

        await Session.update(p.parentSessionID, (draft) => {
          const existing = draft.pendingSubagentNotices ?? []
          // Idempotency: replace by jobId (latest wins)
          const filtered = existing.filter((n) => n.jobId !== notice.jobId)
          filtered.push(notice)
          draft.pendingSubagentNotices = filtered
        })

        log.info("PendingSubagentNotice appended", {
          jobId: p.jobId,
          parentSessionID: p.parentSessionID,
          childSessionID: p.childSessionID,
          status: p.status,
          finish: p.finish,
          queueDepth: (parent.pendingSubagentNotices?.length ?? 0) + 1,
        })

        // ── bugfix/subagent-double-turn: auto-resume idempotency + coalesce ──
        // The append above (pendingSubagentNotices, latest-wins by jobId) is one
        // idempotency domain; auto-resume is a SEPARATE one and previously had
        // NO per-jobId guard. That caused the "two souls" double-turn: every
        // TaskCompletedEvent — including an orphan-reconcile re-fire after a
        // daemon restart, and every distinct jobId from a multi-subagent fan-out —
        // minted its own persisted synthetic user message and started its own
        // parent turn, so the parent re-ran equivalent work each turn.
        //
        // Two guards, claimed atomically under the lock-serialized Session.update:
        //   (DD-1/DD-3) per-jobId resume ledger — if this jobId already triggered
        //     a resume, only the append above happens; never a second turn. The
        //     ledger is persisted (not in-memory) because the re-fire path IS
        //     daemon restart, where in-memory state is already gone.
        //   (DD-5) coalesce — if the parent already has a pending continuation
        //     queued (e.g. a sibling subagent's resume from moments ago, not yet
        //     drained), do NOT enqueue another. RunQueue is per-session
        //     replace-one, so the single queued turn will drain ALL notices at
        //     once; a second synthetic message would just be redundant residue.
        let alreadyResumed = false
        await Session.update(p.parentSessionID, (draft) => {
          const ledger = draft.resumedSubagentJobIds ?? []
          if (ledger.includes(p.jobId)) {
            alreadyResumed = true
            return
          }
          // Claim this jobId now (before the async enqueue) so a concurrent
          // re-fire of the same jobId loses the race and skips.
          const next = [...ledger, p.jobId]
          // DD-3 bounded FIFO: drop oldest entries beyond the cap.
          draft.resumedSubagentJobIds =
            next.length > MAX_RESUMED_JOBIDS ? next.slice(next.length - MAX_RESUMED_JOBIDS) : next
        })

        if (alreadyResumed) {
          log.info("auto-resume: skipped (jobId already resumed)", {
            jobId: p.jobId,
            parentSessionID: p.parentSessionID,
            reason: "already_resumed",
          })
          return
        }

        // DD-5 coalesce: a pending continuation already exists → the queued turn
        // will drain this notice too. Skip enqueuing a duplicate synthetic msg.
        const existingPending = await getPendingContinuation(p.parentSessionID).catch(() => undefined)
        if (existingPending) {
          log.info("auto-resume: coalesced into existing pending continuation", {
            jobId: p.jobId,
            parentSessionID: p.parentSessionID,
            reason: "pending_continuation_exists",
          })
          // Still nudge the resume tick so the queued continuation runs.
          await resumePendingContinuations({
            maxCount: 1,
            preferredSessionID: p.parentSessionID,
          }).catch(() => undefined)
          return
        }

        // Auto-resume parent runloop so the notice gets drained into the
        // system-prompt addendum on the next turn without waiting for the
        // user to type something. Without this, a parent that fired off
        // subagent work and went to sleep (autonomous=false, fire-and-forget
        // task tool) would silently park the notice and the user would
        // come back to a stalled session even though the child finished
        // cleanly. The user explicitly invoked task tool — they expect
        // a follow-up; treat subagent completion as the implicit trigger.
        //
        // Find the latest user message to thread agent/model/variant for
        // arbitration. SqliteStore.stream yields id-DESC, so the first
        // user we encounter while iterating is the latest one.
        let latestUser: MessageV2.User | undefined
        try {
          for await (const m of MessageV2.stream(p.parentSessionID)) {
            if (m.info.role === "user") {
              latestUser = m.info as MessageV2.User
              break
            }
          }
        } catch (streamErr) {
          log.warn("auto-resume: failed to read latest user from parent stream", {
            jobId: p.jobId,
            parentSessionID: p.parentSessionID,
            error: streamErr instanceof Error ? streamErr.message : String(streamErr),
          })
        }
        if (latestUser) {
          try {
            await enqueueAutonomousContinue({
              sessionID: p.parentSessionID,
              user: latestUser,
              text: `Subagent ${p.childSessionID} finished (status=${p.status}). Drain pending notices and continue.`,
              triggerType: p.status === "success" ? "task_completion" : "task_failure",
              priority: "critical",
            })
            await resumePendingContinuations({
              maxCount: 1,
              preferredSessionID: p.parentSessionID,
            })
            log.info("auto-resume: parent runloop enqueued after notice", {
              jobId: p.jobId,
              parentSessionID: p.parentSessionID,
            })
          } catch (resumeErr) {
            log.warn("auto-resume: enqueueAutonomousContinue failed", {
              jobId: p.jobId,
              parentSessionID: p.parentSessionID,
              error: resumeErr instanceof Error ? resumeErr.message : String(resumeErr),
            })
          }
        } else {
          log.warn("auto-resume: no user message found on parent; cannot enqueue", {
            jobId: p.jobId,
            parentSessionID: p.parentSessionID,
          })
        }
      } catch (e) {
        log.warn("pending-notice-appender failed", {
          jobId: p.jobId,
          parentSessionID: p.parentSessionID,
          error: e instanceof Error ? e.message : String(e),
        })
      }
    }

    if (directory) {
      await Instance.provide({ directory, fn: run })
    } else {
      await run()
    }
  })
}
