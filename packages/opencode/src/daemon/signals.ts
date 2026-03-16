import { Log } from "../util/log"

/**
 * Signal dispatch for daemon lifecycle (D.3.2).
 *
 * Maps OS signals to daemon actions:
 *   - SIGTERM/SIGINT → shutdown (graceful stop)
 *   - SIGUSR1 → restart (drain then respawn/reset)
 *
 * IDEF0 reference: A32 (Handle Signal Dispatch)
 * GRAFCET reference: opencode_a3_grafcet.json steps S3, S4
 * Benchmark: refs/openclaw/src/cli/gateway-cli/run-loop.ts
 */
export namespace Signals {
  const log = Log.create({ service: "daemon.signals" })

  export type SignalAction = "shutdown" | "restart"

  type SignalHandler = (action: SignalAction) => void

  let handler: SignalHandler | undefined
  let registered = false

  /**
   * Register signal handlers with a callback.
   * Only one handler can be active at a time.
   */
  export function register(onSignal: SignalHandler): void {
    if (registered) {
      log.warn("signal handlers already registered, replacing")
      unregister()
    }

    handler = onSignal

    process.on("SIGTERM", handleShutdown)
    process.on("SIGINT", handleShutdown)
    process.on("SIGUSR1", handleRestart)

    registered = true
    log.info("signal handlers registered")
  }

  /**
   * Unregister signal handlers.
   */
  export function unregister(): void {
    process.removeListener("SIGTERM", handleShutdown)
    process.removeListener("SIGINT", handleShutdown)
    process.removeListener("SIGUSR1", handleRestart)
    handler = undefined
    registered = false
    log.info("signal handlers unregistered")
  }

  function handleShutdown(): void {
    log.info("received shutdown signal")
    handler?.("shutdown")
  }

  function handleRestart(): void {
    log.info("received restart signal (SIGUSR1)")
    handler?.("restart")
  }
}
