import { Log } from "../util/log"

/**
 * System event queue — in-memory FIFO per session key (D.2.4).
 *
 * Events are transient notifications (not durable state).
 * Drained on heartbeat and injected into heartbeat prompt context.
 *
 * IDEF0 reference: A23 (Dispatch System Event)
 * GRAFCET reference: opencode_a2_grafcet.json steps S2, S3
 * Design decision: DD-10 (in-memory FIFO, max 20 per session)
 * Benchmark: refs/openclaw/src/infra/system-events.ts
 */
export namespace SystemEvents {
  const log = Log.create({ service: "cron.system-events" })

  const MAX_EVENTS = 20

  export type SystemEvent = {
    text: string
    ts: number
    contextKey?: string | null
  }

  // Session-scoped event queues
  const queues = new Map<string, SystemEvent[]>()

  /**
   * Enqueue a system event for a session.
   * Deduplicates consecutive identical texts.
   * Drops oldest if queue exceeds MAX_EVENTS.
   */
  export function enqueue(
    text: string,
    opts: { sessionKey: string; contextKey?: string },
  ): void {
    const { sessionKey, contextKey } = opts
    let queue = queues.get(sessionKey)
    if (!queue) {
      queue = []
      queues.set(sessionKey, queue)
    }

    // Deduplicate consecutive identical texts
    const last = queue[queue.length - 1]
    if (last && last.text === text) {
      log.info("dedup suppressed", { sessionKey, text: text.slice(0, 50) })
      return
    }

    const event: SystemEvent = {
      text,
      ts: Date.now(),
      contextKey: contextKey ?? null,
    }

    queue.push(event)

    // Enforce max size — drop oldest
    while (queue.length > MAX_EVENTS) {
      queue.shift()
    }

    log.info("enqueued", { sessionKey, queueSize: queue.length })
  }

  /**
   * Drain all events for a session (remove and return).
   * Used during heartbeat to inject events into prompt context.
   */
  export function drain(sessionKey: string): SystemEvent[] {
    const queue = queues.get(sessionKey)
    if (!queue || queue.length === 0) return []

    const events = [...queue]
    queue.length = 0
    log.info("drained", { sessionKey, count: events.length })
    return events
  }

  /**
   * Peek at events without removing them.
   */
  export function peek(sessionKey: string): readonly SystemEvent[] {
    return queues.get(sessionKey) ?? []
  }

  /**
   * Check if any events are pending for a session.
   */
  export function hasPending(sessionKey: string): boolean {
    const queue = queues.get(sessionKey)
    return !!queue && queue.length > 0
  }

  /**
   * Check if the latest event's contextKey differs from a given key.
   * Used to detect context switches in heartbeat evaluation.
   */
  export function isContextChanged(sessionKey: string, currentContextKey: string): boolean {
    const queue = queues.get(sessionKey)
    if (!queue || queue.length === 0) return false
    const latest = queue[queue.length - 1]
    return latest.contextKey !== null && latest.contextKey !== currentContextKey
  }

  /**
   * Clear all events for a session.
   */
  export function clear(sessionKey: string): void {
    queues.delete(sessionKey)
  }

  /**
   * Clear all event queues (used during daemon restart).
   */
  export function clearAll(): void {
    queues.clear()
  }

  /**
   * Get queue size for a session.
   */
  export function size(sessionKey: string): number {
    return queues.get(sessionKey)?.length ?? 0
  }
}
