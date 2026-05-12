import z from "zod"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { Identifier } from "@/id/id"
import { Log } from "@/util/log"
import { RuntimeEventService } from "@/system/runtime-event-service"

const log = Log.create({ service: "rebind-epoch" })

export const RebindTrigger = z.enum([
  "daemon_start",
  "session_resume",
  "provider_switch",
  "slash_reload",
  "tool_call",
  "file_mtime",
])
export type RebindTrigger = z.infer<typeof RebindTrigger>

type EpochEntry = {
  epoch: number
  lastBumpAt: number
  lastTrigger: RebindTrigger
  /** Sliding-window timestamps of recent bumps, truncated to the window duration */
  windowBumps: number[]
}

/**
 * Categorical label describing what kind of chain-identity change is
 * driving this bump. Mirrors session/continuation/ContinuationDecision
 * .chainBreakClass; surfaced on session.rebind event payload so
 * downstream consumers (telemetry dashboard, audit jq queries) can
 * filter SS-break vs SL-noop vs capability-only without reaching into
 * the chain.init.* sibling events.
 *
 * Optional — direct RebindEpoch.bumpEpoch callers that predate
 * session/rebind-procedure-revision can omit it; the field then
 * defaults to null in the event payload.
 */
export type ChainBreakClass = "SS-break" | "SL-noop" | "capability-only" | "user-intent" | "preserved"

export type BumpEpochInput = {
  sessionID: string
  trigger: RebindTrigger
  reason?: string
  /** Set by Continuation.run when dispatching; null/undefined for direct callers. */
  chainBreakClass?: ChainBreakClass
}

export type BumpEpochOutcome = {
  status: "bumped" | "rate_limited"
  previousEpoch: number
  currentEpoch: number
  rateLimitReason: string | null
}

export type EpochStats = {
  asOf: number
  entries: Array<{
    sessionID: string
    epoch: number
    lastBumpAt: number
    lastTrigger: RebindTrigger
  }>
}

/** Sliding-window rate limit: at most 5 bumps per 1000ms per session (DD-11). */
const RATE_LIMIT_WINDOW_MS = 1000
const RATE_LIMIT_MAX = 5

const SessionDeletedEvent = BusEvent.define(
  "session.deleted",
  z.object({
    info: z.object({
      id: Identifier.schema("session"),
    }),
  }),
)

const registry = new Map<string, EpochEntry>()

let _subscribed = false
function ensureSubscribed() {
  if (_subscribed) return
  _subscribed = true
  Bus.subscribe(SessionDeletedEvent, (evt) => {
    RebindEpoch.clearSession(evt.properties.info.id)
  })
}

function pruneWindow(entry: EpochEntry, now: number) {
  const cutoff = now - RATE_LIMIT_WINDOW_MS
  while (entry.windowBumps.length > 0 && entry.windowBumps[0] < cutoff) {
    entry.windowBumps.shift()
  }
}

async function appendEventSafe(input: {
  sessionID: string
  level: "info" | "warn"
  domain: "workflow" | "anomaly"
  eventType: string
  anomalyFlags?: string[]
  payload: Record<string, unknown>
}) {
  try {
    await RuntimeEventService.append({
      sessionID: input.sessionID,
      level: input.level,
      domain: input.domain,
      eventType: input.eventType,
      anomalyFlags: input.anomalyFlags ?? [],
      payload: input.payload as any,
    })
  } catch (err) {
    log.warn("[rebind-epoch] failed to append event", {
      sessionID: input.sessionID,
      eventType: input.eventType,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export namespace RebindEpoch {
  /** Read current epoch for a session. Returns 0 if the session has never been bumped. */
  export function current(sessionID: string): number {
    return registry.get(sessionID)?.epoch ?? 0
  }

  /** Return a telemetry snapshot of in-memory epoch state (test + ops support). */
  export function stats(): EpochStats {
    const asOf = Date.now()
    const entries = Array.from(registry.entries()).map(([sessionID, entry]) => ({
      sessionID,
      epoch: entry.epoch,
      lastBumpAt: entry.lastBumpAt,
      lastTrigger: entry.lastTrigger,
    }))
    return { asOf, entries }
  }

  /**
   * Bump the session's epoch, enforcing rate limit (DD-11) and emitting the
   * session.rebind event on success (or session.rebind_storm anomaly on
   * rate-limit rejection). Callers reading `BumpEpochOutcome.status === "bumped"`
   * should treat that as the cache-invalidation signal.
   */
  export async function bumpEpoch(input: BumpEpochInput): Promise<BumpEpochOutcome> {
    ensureSubscribed()
    const now = Date.now()
    let entry = registry.get(input.sessionID)
    if (!entry) {
      entry = {
        epoch: 0,
        lastBumpAt: 0,
        lastTrigger: input.trigger,
        windowBumps: [],
      }
      registry.set(input.sessionID, entry)
    }
    pruneWindow(entry, now)

    if (entry.windowBumps.length >= RATE_LIMIT_MAX) {
      const observedCount = entry.windowBumps.length + 1
      log.warn("[rebind-epoch] rate limit exceeded", {
        sessionID: input.sessionID,
        trigger: input.trigger,
        windowMs: RATE_LIMIT_WINDOW_MS,
        maxPerWindow: RATE_LIMIT_MAX,
        observedCount,
      })
      await appendEventSafe({
        sessionID: input.sessionID,
        level: "warn",
        domain: "anomaly",
        eventType: "session.rebind_storm",
        anomalyFlags: ["rebind_storm"],
        payload: {
          trigger: input.trigger,
          windowMs: RATE_LIMIT_WINDOW_MS,
          maxPerWindow: RATE_LIMIT_MAX,
          observedCount,
        },
      })
      return {
        status: "rate_limited",
        previousEpoch: entry.epoch,
        currentEpoch: entry.epoch,
        rateLimitReason: `rate_limit:${observedCount}/${RATE_LIMIT_MAX} per ${RATE_LIMIT_WINDOW_MS}ms`,
      }
    }

    const previousEpoch = entry.epoch
    entry.epoch = previousEpoch + 1
    entry.lastBumpAt = now
    entry.lastTrigger = input.trigger
    entry.windowBumps.push(now)

    log.info("[rebind-epoch] bumped", {
      sessionID: input.sessionID,
      trigger: input.trigger,
      previousEpoch,
      currentEpoch: entry.epoch,
      reason: input.reason ?? null,
    })
    await appendEventSafe({
      sessionID: input.sessionID,
      level: "info",
      domain: "workflow",
      eventType: "session.rebind",
      payload: {
        trigger: input.trigger,
        previousEpoch,
        currentEpoch: entry.epoch,
        reason: input.reason ?? null,
        // 2026-05-12 (Phase D of session/rebind-procedure-revision):
        // surface chain-break classification on the canonical workflow
        // event so dashboards filtering session.rebind can distinguish
        // SS-break vs SL-noop without correlating against the sibling
        // chain.init.* events. Null when the bumper didn't classify
        // (direct callers that predate Continuation.run dispatch).
        chainBreakClass: input.chainBreakClass ?? null,
      },
    })

    return {
      status: "bumped",
      previousEpoch,
      currentEpoch: entry.epoch,
      rateLimitReason: null,
    }
  }

  /**
   * Drop in-memory state for a session. Called automatically on
   * `session.deleted` bus events via `ensureSubscribed`, but also exposed for
   * explicit cleanup (test harness, manual ops).
   */
  export function clearSession(sessionID: string) {
    registry.delete(sessionID)
  }

  /** Full reset — tests only. */
  export function reset() {
    registry.clear()
  }
}

export const REBIND_RATE_LIMIT = {
  windowMs: RATE_LIMIT_WINDOW_MS,
  maxPerWindow: RATE_LIMIT_MAX,
} as const
