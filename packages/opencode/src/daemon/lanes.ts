import { Log } from "../util/log"
import { Drain } from "./drain"

/**
 * Command lane queue with concurrency control (D.3.4-D.3.5, D.3.7).
 *
 * Each lane has its own FIFO queue, concurrency limit, and generation number.
 * Generation numbers are bumped on restart to invalidate stale task completions.
 *
 * IDEF0 reference: A41-A44 (Govern Command Lane Execution)
 * GRAFCET reference: opencode_a4_grafcet.json (full state machine)
 * Design decision: DD-12 (lane concurrency defaults)
 * Benchmark: refs/openclaw/src/process/command-queue.ts
 */
export namespace Lanes {
  const log = Log.create({ service: "daemon.lanes" })

  // DD-12: Lane concurrency defaults
  export enum CommandLane {
    Main = "main",
    Cron = "cron",
    Subagent = "subagent",
    Nested = "nested",
  }

  const DEFAULT_CONCURRENCY: Record<CommandLane, number> = {
    [CommandLane.Main]: 1,
    [CommandLane.Cron]: 1,
    [CommandLane.Subagent]: 2,
    [CommandLane.Nested]: 1,
  }

  type QueueEntry<T = unknown> = {
    id: number
    task: () => Promise<T>
    resolve: (value: T) => void
    reject: (error: Error) => void
    generation: number
  }

  type LaneState = {
    queue: QueueEntry[]
    activeTaskIds: Set<number>
    maxConcurrent: number
    generation: number
    draining: boolean // per-lane pump guard
  }

  let taskIdCounter = 0
  const lanes = new Map<CommandLane, LaneState>()

  /**
   * Initialize all lanes with default concurrency (D.3.4, GRAFCET step S0).
   */
  export function register(overrides?: Partial<Record<CommandLane, number>>): void {
    for (const lane of Object.values(CommandLane)) {
      const maxConcurrent = overrides?.[lane] ?? DEFAULT_CONCURRENCY[lane]
      lanes.set(lane, {
        queue: [],
        activeTaskIds: new Set(),
        maxConcurrent,
        generation: 0,
        draining: false,
      })
    }
    log.info("lanes registered", {
      lanes: Object.fromEntries(
        [...lanes.entries()].map(([k, v]) => [k, v.maxConcurrent]),
      ),
    })
  }

  /**
   * Enqueue a task in a lane (D.3.4, GRAFCET steps S1-S2).
   * Rejects with GatewayDrainingError if daemon is draining.
   */
  export function enqueue<T>(
    lane: CommandLane,
    task: () => Promise<T>,
  ): Promise<T> {
    if (Drain.isDraining()) {
      return Promise.reject(new GatewayDrainingError())
    }

    const laneState = getLane(lane)
    const id = ++taskIdCounter
    const generation = laneState.generation

    return new Promise<T>((resolve, reject) => {
      laneState.queue.push({ id, task: task as () => Promise<unknown>, resolve: resolve as (v: unknown) => void, reject, generation })
      pump(lane)
    })
  }

  /**
   * Pump the lane: execute queued tasks up to maxConcurrent (D.3.5, GRAFCET step S4).
   */
  function pump(lane: CommandLane): void {
    const laneState = getLane(lane)
    if (laneState.draining) return

    while (
      laneState.queue.length > 0 &&
      laneState.activeTaskIds.size < laneState.maxConcurrent
    ) {
      const entry = laneState.queue.shift()!
      laneState.activeTaskIds.add(entry.id)

      void executeEntry(lane, laneState, entry)
    }
  }

  async function executeEntry<T>(
    lane: CommandLane,
    laneState: LaneState,
    entry: QueueEntry<T>,
  ): Promise<void> {
    try {
      const result = await (entry.task as () => Promise<T>)()

      // Validate generation before resolving (D.3.7, GRAFCET step S6)
      if (entry.generation !== laneState.generation) {
        log.warn("stale task completion — generation mismatch", {
          lane,
          taskId: entry.id,
          taskGen: entry.generation,
          currentGen: laneState.generation,
        })
        entry.reject(new CommandLaneClearedError())
        return
      }

      entry.resolve(result)
    } catch (e) {
      entry.reject(e instanceof Error ? e : new Error(String(e)))
    } finally {
      laneState.activeTaskIds.delete(entry.id)
      pump(lane)
    }
  }

  /**
   * Reset all lanes — bump generation, clear active sets, reject queued entries (D.3.8).
   * Called post-restart to invalidate stale tasks.
   *
   * IDEF0 reference: A44 (Reset Lane State Post Restart)
   * GRAFCET reference: opencode_a4_grafcet.json step S7
   */
  export function resetAll(): void {
    for (const [lane, laneState] of lanes.entries()) {
      laneState.generation++

      // Reject all queued entries
      for (const entry of laneState.queue) {
        entry.reject(new CommandLaneClearedError())
      }
      laneState.queue = []
      laneState.activeTaskIds.clear()
      laneState.draining = false

      log.info("lane reset", { lane, generation: laneState.generation })
    }
  }

  /**
   * Get total active task count across all lanes.
   */
  export function totalActiveTasks(): number {
    let total = 0
    for (const laneState of lanes.values()) {
      total += laneState.activeTaskIds.size
    }
    return total
  }

  /**
   * Get queue size for a specific lane.
   */
  export function queueSize(lane: CommandLane): number {
    const laneState = lanes.get(lane)
    if (!laneState) return 0
    return laneState.queue.length + laneState.activeTaskIds.size
  }

  /**
   * Check if all lanes have no active tasks.
   */
  export function isIdle(): boolean {
    return totalActiveTasks() === 0
  }

  /**
   * Get lane info for monitoring (D.3.8).
   */
  export function info(): Record<string, { queued: number; active: number; maxConcurrent: number; generation: number }> {
    const result: Record<string, any> = {}
    for (const [lane, laneState] of lanes.entries()) {
      result[lane] = {
        queued: laneState.queue.length,
        active: laneState.activeTaskIds.size,
        maxConcurrent: laneState.maxConcurrent,
        generation: laneState.generation,
      }
    }
    return result
  }

  function getLane(lane: CommandLane): LaneState {
    let laneState = lanes.get(lane)
    if (!laneState) {
      // Auto-register with defaults if not yet registered
      laneState = {
        queue: [],
        activeTaskIds: new Set(),
        maxConcurrent: DEFAULT_CONCURRENCY[lane] ?? 1,
        generation: 0,
        draining: false,
      }
      lanes.set(lane, laneState)
    }
    return laneState
  }

  // --- Error types ---

  export class GatewayDrainingError extends Error {
    constructor() {
      super("Gateway is draining — new enqueues rejected")
      this.name = "GatewayDrainingError"
    }
  }

  export class CommandLaneClearedError extends Error {
    constructor() {
      super("Command lane cleared — task invalidated by restart")
      this.name = "CommandLaneClearedError"
    }
  }
}
