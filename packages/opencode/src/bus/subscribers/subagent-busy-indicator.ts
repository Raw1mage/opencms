/**
 * subagent-busy-indicator
 *
 * Bridges SessionActiveChild lifecycle to SessionStatus so the parent
 * session keeps showing busy (clock + stop button) while a subagent
 * runs in the background. Restores pre-Phase-9 visible-busy + still-
 * interactive coexistence (responsive-orchestrator c32ba0dac flipped
 * the task tool to fire-and-forget, which silently dropped the
 * visible signal even though the parent was still effectively
 * waiting on the child).
 *
 * State machine:
 *
 *   active child set  → parent.status = busy (idempotent if already)
 *   active child null → parent.status = idle, IFF no runtime owns this
 *                       session right now (runtime owners take precedence
 *                       — they will set their own status when they finish)
 *
 * The runtime-finish path (`prompt-runtime.ts:finish()`) is the
 * complement: it now skips the idle transition when a child is still
 * attached, so this subscriber is the sole source of the C → D edge
 * (no-runtime + no-child).
 */

import { Bus } from "../index"
import { SessionActiveChildEvent } from "@/tool/task"
import { SessionStatus } from "@/session/status"
import { isRuntimeRegistered } from "@/session/prompt-runtime"
import { Log } from "@/util/log"

const log = Log.create({ service: "subagent-busy-indicator" })

let registered = false

export function registerSubagentBusyIndicatorSubscriber() {
  if (registered) return
  registered = true

  Bus.subscribeGlobal(SessionActiveChildEvent.type, 0, async (event) => {
    const { parentSessionID, activeChild } = event.properties

    if (activeChild) {
      // Child attached. Ensure parent shows busy. The parent's runloop
      // (if running) sets busy on its own each iteration, so this is
      // mostly a no-op when state is A→B; the meaningful case is when
      // a fast user interaction means the runloop already exited and
      // the dispatched-result return is racing the child set event.
      const current = SessionStatus.get(parentSessionID)
      if (current.type !== "busy") {
        SessionStatus.set(parentSessionID, { type: "busy" })
        log.info("child attached: status forced busy", { parentSessionID })
      }
      return
    }

    // Child detached. Only release to idle if no runtime currently owns
    // the session — otherwise the runtime is the source of truth and
    // its own finish() will eventually set idle.
    if (!isRuntimeRegistered(parentSessionID)) {
      SessionStatus.set(parentSessionID, { type: "idle" })
      log.info("child detached + no runtime: status set idle", { parentSessionID })
    } else {
      log.info("child detached, runtime still active: status untouched", { parentSessionID })
    }
  })
}
