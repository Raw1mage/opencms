import { Log } from "../util/log"
import { GatewayLock } from "./gateway-lock"
import { Signals } from "./signals"
import { Drain } from "./drain"
import { Lanes } from "./lanes"
import { Restart } from "./restart"
import { CronRetention } from "../cron/retention"
import { Heartbeat } from "../cron/heartbeat"
import { ChannelStore } from "../channel"

export { GatewayLock } from "./gateway-lock"
export { Signals } from "./signals"
export { Drain } from "./drain"
export { Lanes } from "./lanes"
export { Restart } from "./restart"

/**
 * Daemon lifecycle manager (D.3).
 *
 * Orchestrates all daemon components:
 *   - Gateway lock (singleton)
 *   - Signal handlers (SIGTERM/SIGINT/SIGUSR1)
 *   - Command lane queue with concurrency
 *   - Drain state machine
 *   - Restart loop
 *   - Cron retention reaper + heartbeat scheduler
 *
 * IDEF0 reference: A3 (Supervise Daemon Lifecycle)
 * GRAFCET reference: opencode_a3_grafcet.json (full state machine)
 */
export namespace Daemon {
  const log = Log.create({ service: "daemon" })

  export type DaemonState = "stopped" | "starting" | "running" | "draining" | "restarting"

  let daemonState: DaemonState = "stopped"

  /**
   * Start the daemon: acquire lock, register signals, initialize lanes.
   * GRAFCET steps S0-S2.
   */
  export async function start(opts?: {
    laneConcurrency?: Partial<Record<Lanes.CommandLane, number>>
    heartbeat?: Partial<Heartbeat.HeartbeatConfig>
    retentionMs?: number
  }): Promise<boolean> {
    if (daemonState !== "stopped") {
      log.warn("daemon already started", { state: daemonState })
      return false
    }

    daemonState = "starting"

    // Acquire gateway lock (GRAFCET step S0)
    const lockAcquired = await GatewayLock.acquire()
    if (!lockAcquired) {
      log.error("failed to acquire gateway lock — another instance is running")
      daemonState = "stopped"
      return false
    }

    // Register signal handlers (GRAFCET step S1)
    Signals.register(async (action) => {
      if (action === "shutdown") {
        await shutdown()
      } else if (action === "restart") {
        await restart()
      }
    })

    // Initialize default command lanes
    Lanes.register(opts?.laneConcurrency)

    // Restore channels and register per-channel lanes
    const channels = await ChannelStore.restoreOrBootstrap()
    for (const ch of channels) {
      if (ch.id !== "default" && ch.enabled) {
        Lanes.registerChannel({ channelId: ch.id, concurrency: ch.lanePolicy })
      }
    }

    // Recover cron schedules from persisted state before registering heartbeat
    await Heartbeat.recoverSchedules()

    // Start cron subsystems
    CronRetention.register({ retentionMs: opts?.retentionMs })
    Heartbeat.register(opts?.heartbeat)

    daemonState = "running"
    log.info("daemon started", { pid: process.pid })
    return true
  }

  /**
   * Graceful shutdown: drain and exit.
   * GRAFCET step S3 → S5-S8.
   */
  export async function shutdown(): Promise<void> {
    if (daemonState !== "running") {
      log.warn("shutdown called in non-running state", { state: daemonState })
      return
    }

    daemonState = "draining"
    Drain.enter("shutdown")

    // Wait for active tasks
    await Drain.waitFor(() => Lanes.isIdle(), { timeoutMs: 5_000 })
    Drain.complete()

    // Release lock and clean up
    Signals.unregister()
    await GatewayLock.release()

    daemonState = "stopped"
    log.info("daemon stopped")
  }

  /**
   * Restart: drain, reset lanes, reacquire lock.
   * GRAFCET step S4 → S5-S10.
   */
  export async function restart(): Promise<void> {
    if (daemonState !== "running") {
      log.warn("restart called in non-running state", { state: daemonState })
      return
    }

    daemonState = "restarting"
    const result = await Restart.execute()

    if (result.method === "failed") {
      log.error("restart failed — shutting down", { error: result.error })
      await shutdown()
      return
    }

    daemonState = "running"
    log.info("daemon restarted", { method: result.method, generation: result.generation })
  }

  /**
   * Get daemon info for monitoring (D.3.8).
   */
  export function info(): DaemonInfo {
    return {
      state: daemonState,
      pid: process.pid,
      drain: Drain.getState(),
      lanes: Lanes.info(),
      activeTasks: Lanes.totalActiveTasks(),
    }
  }

  export type DaemonInfo = {
    state: DaemonState
    pid: number
    drain: { state: Drain.DrainState; reason: Drain.DrainReason | undefined }
    lanes: Record<string, { queued: number; active: number; maxConcurrent: number; generation: number }>
    activeTasks: number
  }
}
