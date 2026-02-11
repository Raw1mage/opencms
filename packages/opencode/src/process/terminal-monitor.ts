import { Log } from "@/util/log"
import { ProcessSupervisor } from "@/process/supervisor"

/**
 * Terminal Connection Monitor
 *
 * Proactively detects when the main process becomes orphaned (PPID changes to 1)
 * and triggers cleanup before the process can accumulate as high-load orphan.
 *
 * This is a defense-in-depth mechanism that complements signal handlers:
 * - Signal handlers: Reactive (respond to SIGHUP/SIGTERM)
 * - This monitor: Proactive (detect orphan state before it causes issues)
 *
 * @event_20260211_terminal_heartbeat
 */
export namespace TerminalMonitor {
  const log = Log.create({ service: "terminal.monitor" })

  let monitorInterval: Timer | undefined
  let initialPPID: number | undefined
  let isShuttingDown = false

  export type Options = {
    /**
     * How often to check PPID (milliseconds)
     * Default: 1000ms (1 second)
     */
    checkInterval?: number

    /**
     * Callback invoked when orphan state is detected
     * If not provided, will call ProcessSupervisor.disposeAll() and exit
     */
    onOrphan?: () => void | Promise<void>
  }

  /**
   * Start monitoring terminal connection
   * Call this once at application startup
   */
  export function start(options: Options = {}) {
    const { checkInterval = 1000, onOrphan } = options

    initialPPID = process.ppid
    log.info("terminal monitor started", { ppid: initialPPID, interval: checkInterval })

    monitorInterval = setInterval(async () => {
      const currentPPID = process.ppid

      // Check if we became an orphan (parent process died, adopted by init)
      if (currentPPID === 1 && initialPPID !== 1) {
        log.warn("orphan state detected", {
          initialPPID,
          currentPPID,
          reason: "parent process terminated without sending signal",
        })

        if (isShuttingDown) {
          log.info("already shutting down, skipping duplicate cleanup")
          return
        }

        isShuttingDown = true
        stop()

        if (onOrphan) {
          await onOrphan()
        } else {
          await defaultOrphanHandler()
        }
      }

      // Check for PPID change (parent process replaced)
      if (currentPPID !== initialPPID && currentPPID !== 1) {
        log.info("ppid changed", {
          from: initialPPID,
          to: currentPPID,
          note: "parent process replaced, updating baseline",
        })
        initialPPID = currentPPID
      }
    }, checkInterval)
  }

  /**
   * Stop monitoring (cleanup on shutdown)
   */
  export function stop() {
    if (monitorInterval) {
      clearInterval(monitorInterval)
      monitorInterval = undefined
      log.info("terminal monitor stopped")
    }
  }

  /**
   * Default handler when orphan state is detected
   */
  async function defaultOrphanHandler() {
    log.warn("initiating emergency shutdown due to orphan state")

    try {
      // Give ProcessSupervisor a chance to cleanup
      await Promise.race([
        ProcessSupervisor.disposeAll(),
        new Promise((resolve) => setTimeout(resolve, 2000)), // 2s timeout
      ])

      log.info("cleanup completed, exiting")
    } catch (error) {
      log.error("cleanup failed", { error })
    } finally {
      // Force exit to prevent lingering
      process.exit(1)
    }
  }

  /**
   * Check if currently in orphan state
   */
  export function isOrphan(): boolean {
    return process.ppid === 1 && initialPPID !== 1
  }

  /**
   * Get current monitoring state
   */
  export function status() {
    return {
      active: monitorInterval !== undefined,
      initialPPID,
      currentPPID: process.ppid,
      isOrphan: isOrphan(),
    }
  }
}
