import { Bus } from "@/bus"
import { Event as ServerEvent } from "@/server/event"
import { Session } from "@/session"
import { Log } from "@/util/log"

const log = Log.create({ service: "autorun.observer" })

/**
 * specs/autonomous-opt-in/ Phase 5 (new Phase 2 under main-as-SSOT
 * revision) — disarm observer.
 *
 * Verbal disarm (user types `停` / `stop` / …) is already handled by the
 * ingest-path detector in prompt.ts. This observer covers the other disarm
 * vector: killswitch activation — when an operator hits the emergency
 * stop, every autonomous-armed session in the instance must quiesce.
 *
 * Subscriber is registered once at daemon startup via
 * `registerAutorunDisarmObserver()` in index.ts. On KillSwitchChanged with
 * `active=true`, we enumerate global sessions and flip armed ones to
 * disabled via the canonical `Session.updateAutonomous` path. Sessions
 * that are already disarmed are skipped silently.
 *
 * Scope intentionally narrow:
 * - only killswitch event (not abort / blocker / user-message); those are
 *   already covered either by existing runloop gates or by the verbal
 *   disarm detector
 * - only flips state; does not enqueue anything; does not emit new Bus
 *   events (the existing `bus.session.workflow.updated` event carries the
 *   change per DD-6 revised)
 */

let _registered = false

export function registerAutorunDisarmObserver() {
  if (_registered) return
  _registered = true
  Bus.subscribe(ServerEvent.KillSwitchChanged, async (event) => {
    if (!event.properties.active) return // only fire on activate
    const reason = event.properties.reason ?? "killswitch_active"
    try {
      await disarmAllArmedSessions(reason)
    } catch (err) {
      log.warn("disarm observer failed during killswitch sweep", {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  })
  log.info("autorun disarm observer registered", {})
}

/**
 * Pure predicate: given a session snapshot, should it be disarmed by a
 * killswitch sweep? Exported for unit testing the policy without needing
 * live Storage.
 */
export function shouldDisarmForKillswitch(session: {
  parentID?: string | null
  workflow?: { autonomous: { enabled: boolean } }
}): boolean {
  if (session.workflow?.autonomous.enabled !== true) return false
  if (session.parentID) return false // subagents don't own the armed flag
  return true
}

export interface DisarmSweepDeps {
  list: () => AsyncIterable<{
    id: string
    parentID?: string | null
    workflow?: { autonomous: { enabled: boolean } }
  }>
  update: (sessionID: string) => Promise<void>
}

/**
 * Iterate all sessions via the injected list iterator and flip any
 * armed-but-not-parent session to disabled via the injected updater.
 * Returns {scanned, disarmed}. Pure orchestration; no I/O coupling.
 */
export async function runDisarmSweep(deps: DisarmSweepDeps, reason: string) {
  let scanned = 0
  let disarmed = 0
  for await (const session of deps.list()) {
    scanned++
    if (!shouldDisarmForKillswitch(session)) continue
    try {
      await deps.update(session.id)
      disarmed++
      log.info("autorun disarmed by killswitch", { sessionID: session.id, reason })
    } catch (err) {
      log.warn("autorun disarm write failed", {
        sessionID: session.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  log.info("autorun disarm sweep complete", { scanned, disarmed, reason })
  return { scanned, disarmed }
}

/**
 * Production binding — uses Session.listGlobal + Session.updateAutonomous.
 * Wrapping kept thin so runDisarmSweep stays easy to test in isolation.
 */
export async function disarmAllArmedSessions(reason: string): Promise<number> {
  const result = await runDisarmSweep(
    {
      list: () => Session.listGlobal() as any,
      update: async (sessionID: string) => {
        await Session.updateAutonomous({ sessionID, policy: { enabled: false } })
      },
    },
    reason,
  )
  return result.disarmed
}
