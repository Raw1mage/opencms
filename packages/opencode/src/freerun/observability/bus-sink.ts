/**
 * harness/freerun-mode — Bus event JSONL sink.
 *
 * Subscribes to every `freerun.*` Bus event and appends a single JSON line
 * per event to `<dataHome>/storage/freerun/<sessionId>/events.jsonl`.
 *
 * Why JSONL not SQLite (recorded here for future readers):
 *   - single-writer, append-only, low rate (~10-30 events/iter, one iter
 *     every 5-30s) — DB transaction overhead outweighs JSONL append
 *   - 100 sessions × 100 iters × 400 B/event ≈ 40 MB, well under any
 *     analytics tool's working-set threshold
 *   - sidecar / llama-server / gpu-exporter all use JSONL or Prometheus
 *     text; keeping freerun consistent eases multi-source joins
 *   - querying via DuckDB-on-JSONL or pandas is one line either way
 *
 * The sink is installed at Engine.run boundary (per-session). Multiple
 * concurrent sessions are fine — each event carries its own sessionID
 * and lands in its own file.
 */

import * as fs from "fs/promises"
import * as path from "path"
import { Bus } from "../../bus"

export namespace BusSink {
  export interface InstallOptions {
    dataHome: string
    /** Filter by session id — events for OTHER sessions are dropped at this sink. */
    sessionId: string
  }

  export interface InstallHandle {
    /** Stop subscribing. Pending writes still complete. */
    dispose(): void
    /** Counter (debug) — number of events written by this sink. */
    readonly writeCount: () => number
  }

  /**
   * Install a sink for the given session id. Subscribes to ALL events via
   * Bus.subscribeAll and filters in-handler — cheaper than 24 separate
   * Bus.subscribe calls.
   */
  export function install(opts: InstallOptions): InstallHandle {
    const filePath = path.join(opts.dataHome, "storage", "freerun", opts.sessionId, "events.jsonl")
    const dirPath = path.dirname(filePath)
    let count = 0
    let disposed = false
    let dirEnsured = false

    const unsubscribe = Bus.subscribeAll((envelope: any) => {
      if (disposed) return
      const type: string | undefined = envelope?.type ?? envelope?.payload?.type
      if (!type || !type.startsWith("freerun.")) return
      const properties = envelope?.properties ?? envelope?.payload?.properties
      const sessionID: string | undefined = properties?.sessionID
      if (sessionID !== opts.sessionId) return

      const record = {
        ts: properties?.at ?? new Date().toISOString(),
        type,
        properties,
      }
      count++

      // Fire-and-forget append. We don't await — Bus subscribers are
      // synchronous callers and adding an await here would push back-pressure
      // into the engine loop. Worst case: process dies before the buffered
      // write flushes; we lose the last few events. For research-grade
      // logging this trade-off is fine; if stronger durability is wanted
      // later, queue events here and fsync periodically.
      void appendOne(filePath, dirPath, record, () => {
        dirEnsured = true
      }, dirEnsured)
    })

    return {
      dispose: () => {
        disposed = true
        unsubscribe()
      },
      writeCount: () => count,
    }
  }

  async function appendOne(
    filePath: string,
    dirPath: string,
    record: unknown,
    markDirEnsured: () => void,
    dirAlreadyEnsured: boolean,
  ): Promise<void> {
    try {
      if (!dirAlreadyEnsured) {
        await fs.mkdir(dirPath, { recursive: true })
        markDirEnsured()
      }
      await fs.appendFile(filePath, JSON.stringify(record) + "\n", "utf-8")
    } catch {
      // Sink failures are silent — observability must never crash the engine.
    }
  }
}
