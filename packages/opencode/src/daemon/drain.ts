import { Log } from "../util/log"

/**
 * Drain state machine (D.3.3).
 *
 * Manages the draining lifecycle during shutdown or restart:
 *   1. Enter drain mode → reject new enqueues
 *   2. Wait for active tasks to complete (with timeout)
 *   3. Wait for active runs to complete (with timeout)
 *   4. Drain complete → proceed to shutdown or restart
 *
 * IDEF0 reference: A33 (Execute Drain State Machine)
 * GRAFCET reference: opencode_a3_grafcet.json steps S5-S8 (divergence_and + convergence_and)
 * Benchmark: refs/openclaw/src/cli/gateway-cli/run-loop.ts
 */
export namespace Drain {
  const log = Log.create({ service: "daemon.drain" })

  export type DrainState = "idle" | "draining" | "drained"
  export type DrainReason = "shutdown" | "restart"

  const DRAIN_TIMEOUT_MS = 90_000 // 90 seconds
  const SHUTDOWN_TIMEOUT_MS = 5_000 // 5 seconds

  let state: DrainState = "idle"
  let reason: DrainReason | undefined

  /**
   * Enter drain mode. New enqueues will be rejected.
   */
  export function enter(drainReason: DrainReason): void {
    if (state !== "idle") {
      log.warn("already draining", { current: state, reason })
      return
    }
    state = "draining"
    reason = drainReason
    log.info("entered drain mode", { reason: drainReason })
  }

  /**
   * Mark drain as complete.
   */
  export function complete(): void {
    state = "drained"
    log.info("drain complete", { reason })
  }

  /**
   * Reset to idle (after restart).
   */
  export function reset(): void {
    state = "idle"
    reason = undefined
    log.info("drain reset to idle")
  }

  /**
   * Check if we're currently draining.
   */
  export function isDraining(): boolean {
    return state === "draining" || state === "drained"
  }

  /**
   * Get current drain state.
   */
  export function getState(): { state: DrainState; reason: DrainReason | undefined } {
    return { state, reason }
  }

  /**
   * Get timeout for the current drain operation.
   */
  export function getTimeoutMs(): number {
    return reason === "restart" ? DRAIN_TIMEOUT_MS : SHUTDOWN_TIMEOUT_MS
  }

  /**
   * Wait for a condition with timeout.
   * Resolves true if condition met, false if timed out.
   */
  export async function waitFor(
    condition: () => boolean,
    opts?: { timeoutMs?: number; pollMs?: number },
  ): Promise<boolean> {
    const timeout = opts?.timeoutMs ?? getTimeoutMs()
    const poll = opts?.pollMs ?? 500
    const deadline = Date.now() + timeout

    while (Date.now() < deadline) {
      if (condition()) return true
      await new Promise((r) => setTimeout(r, poll))
    }

    log.warn("wait timed out", { timeoutMs: timeout })
    return false
  }
}
