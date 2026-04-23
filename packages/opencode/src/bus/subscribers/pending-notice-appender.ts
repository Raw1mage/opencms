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

const log = Log.create({ service: "task.notice" })

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
