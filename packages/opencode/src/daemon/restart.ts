import { Log } from "../util/log"
import { Drain } from "./drain"
import { Lanes } from "./lanes"
import { GatewayLock } from "./gateway-lock"
import { SystemEvents } from "../cron/system-events"

/**
 * Restart loop — respawn or in-process restart with generation bump (D.3.6).
 *
 * Strategy (DD-11):
 *   1. Try full process respawn (clean memory state)
 *   2. Fallback to in-process restart with generation bump
 *
 * IDEF0 reference: A34 (Coordinate Process Restart)
 * GRAFCET reference: opencode_a3_grafcet.json steps S8-S10
 * Benchmark: refs/openclaw/src/cli/gateway-cli/run-loop.ts
 */
export namespace Restart {
  const log = Log.create({ service: "daemon.restart" })

  export type RestartResult = {
    method: "respawn" | "in-process" | "failed"
    generation?: number
    error?: string
  }

  /**
   * Execute restart sequence:
   *   1. Enter drain mode
   *   2. Wait for active tasks to complete
   *   3. Reset lanes (bump generation)
   *   4. Clear transient state (event queues)
   *   5. Reacquire gateway lock
   *   6. Resume
   */
  export async function execute(opts?: {
    noRespawn?: boolean
    drainTimeoutMs?: number
  }): Promise<RestartResult> {
    // 1. Enter drain mode
    Drain.enter("restart")
    log.info("restart sequence started")

    // 2. Wait for active tasks
    const drained = await Drain.waitFor(
      () => Lanes.isIdle(),
      { timeoutMs: opts?.drainTimeoutMs ?? 90_000 },
    )

    if (!drained) {
      log.warn("drain timeout — proceeding with force restart")
    }

    Drain.complete()

    // 3. Try respawn if allowed
    if (!opts?.noRespawn && !process.env.OPENCLAW_NO_RESPAWN) {
      try {
        return await attemptRespawn()
      } catch (e) {
        log.warn("respawn failed, falling back to in-process restart", { error: e })
      }
    }

    // 4. In-process restart: reset lanes (bumps generation)
    return await inProcessRestart()
  }

  async function attemptRespawn(): Promise<RestartResult> {
    // In a real daemon, this would exec() the process.
    // For now, we do in-process restart since we're in a server context.
    log.info("respawn not available in current context, using in-process restart")
    return inProcessRestart()
  }

  async function inProcessRestart(): Promise<RestartResult> {
    // Reset all lanes — bump generation numbers
    Lanes.resetAll()

    // Clear transient state
    SystemEvents.clearAll()

    // Reacquire lock (re-verify we still hold it)
    const lockOk = await GatewayLock.acquire()
    if (!lockOk) {
      log.error("failed to reacquire gateway lock after restart")
      return { method: "failed", error: "lock reacquisition failed" }
    }

    // Re-register lanes
    Lanes.register()

    // Reset drain state
    Drain.reset()

    const info = Lanes.info()
    const generation = Object.values(info)[0]?.generation ?? 0

    log.info("in-process restart complete", { generation })
    return { method: "in-process", generation }
  }
}
