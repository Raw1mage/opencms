import z from "zod"
import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Log } from "../util/log"
import { MessageV2 } from "../session/message-v2"
import { Session } from "../session"
import { Tweaks } from "../config/tweaks"
import type { CacheStats } from "./routes/cache-health"
import { registerCacheStatsProvider } from "./routes/cache-health"

const log = Log.create({ service: "session-cache" })

/**
 * In-process LRU cache for Session.get / Session.messages responses, backed
 * by bus-driven invalidation.
 *
 * Keys:
 *   - session:<sessionID>
 *   - session:<sessionID>:meta
 *   - messages:<sessionID>:<limit>
 *
 * Invariants (see specs/session-poll-cache/invariants.md,
 * specs/frontend-session-lazyload/invariants.md INV-1):
 *   I-1 No entry is served past its TTL.
 *   I-2 Bus bridge coverage ensures worker writes invalidate daemon cache.
 *   I-3 Subscription failure is loud (log.warn, subscriptionAlive=false).
 *   I-4 Per-session version counter strictly monotonically increases on any
 *       MessageV2.Event.* or Session.Event.Created/Updated; cleared on
 *       Session.Event.Deleted.
 *   I-6 When tweaks disable the cache, no entries are built and no counters
 *       are updated.
 */
export namespace SessionCache {
  export interface Entry<T = unknown> {
    data: T
    version: number
    createdAt: number
    accessAt: number
  }

  const HitSchema = z.object({ key: z.string(), sessionID: z.string() })
  const MissSchema = z.object({ key: z.string(), sessionID: z.string(), durationMs: z.number() })
  const InvalidatedSchema = z.object({
    sessionID: z.string(),
    triggeringEventType: z.string(),
    keysDropped: z.number().int().min(0),
  })
  const EvictedSchema = z.object({
    key: z.string(),
    sessionID: z.string(),
    reason: z.enum(["lru", "ttl"]),
  })

  export const Event = {
    Hit: BusEvent.define("session-cache.hit", HitSchema),
    Miss: BusEvent.define("session-cache.miss", MissSchema),
    Invalidated: BusEvent.define("session-cache.invalidated", InvalidatedSchema),
    Evicted: BusEvent.define("session-cache.evicted", EvictedSchema),
  }

  // --- State (per-process) ---

  const entries = new Map<string, Entry>()
  const versions = new Map<string, number>()
  let hits = 0
  let misses = 0
  let invalidations = 0
  let evictions = 0
  let subscriptionAlive = false
  let unsubscribers: Array<() => void> = []

  /**
   * Per-process-lifetime epoch — embedded in ETag so that clients holding
   * a stale ETag after a daemon restart (which resets the version counter
   * to 0) cannot accidentally 304-match against a re-created session at
   * the same numeric version.
   */
  const EPOCH = Date.now().toString(36)

  export function currentEtag(sessionID: string): string {
    return `W/"${sessionID}:${getVersion(sessionID)}:${EPOCH}"`
  }

  export function isEtagMatch(sessionID: string, header: string | null | undefined): boolean {
    if (!header) return false
    return header.trim() === currentEtag(sessionID)
  }

  /**
   * Canonical cache key for the session metadata endpoint (partCount / totalBytes / lastUpdated).
   * Shares the per-session version counter with session:<id> and messages:<id>:<limit>,
   * so INV-1 (meta/session/messages ETag sync) holds.
   */
  export function metaKey(sessionID: string): string {
    return `session:${sessionID}:meta`
  }

  /**
   * Extract the sessionID prefix from a cache key.
   * session:<id>              → <id>
   * session:<id>:meta         → <id>
   * messages:<id>:<limit>     → <id>
   */
  function sessionIdOf(key: string): string | undefined {
    const idx = key.indexOf(":")
    if (idx < 0) return undefined
    const namespace = key.slice(0, idx)
    const rest = key.slice(idx + 1)
    if (namespace === "session") {
      const colon = rest.indexOf(":")
      return colon < 0 ? rest : rest.slice(0, colon)
    }
    if (namespace === "messages") {
      const colon = rest.lastIndexOf(":")
      return colon < 0 ? rest : rest.slice(0, colon)
    }
    return undefined
  }

  async function currentCap(): Promise<{ enabled: boolean; ttlMs: number; max: number }> {
    const cfg = await Tweaks.sessionCache()
    return { enabled: cfg.enabled, ttlMs: cfg.ttlSec * 1000, max: cfg.maxEntries }
  }

  function now(): number {
    return Date.now()
  }

  function bumpVersion(sessionID: string): number {
    const next = (versions.get(sessionID) ?? 0) + 1
    versions.set(sessionID, next)
    return next
  }

  export function getVersion(sessionID: string): number {
    return versions.get(sessionID) ?? 0
  }

  function evictOne(reason: "lru" | "ttl"): void {
    const firstKey = entries.keys().next().value
    if (firstKey === undefined) return
    entries.delete(firstKey)
    evictions += 1
    const sid = sessionIdOf(firstKey) ?? ""
    void Bus.publish(Event.Evicted, { key: firstKey, sessionID: sid, reason })
  }

  async function enforceCapacity(max: number): Promise<void> {
    while (entries.size > max) evictOne("lru")
  }

  /**
   * Fetch via cache. On miss, runs loader() which must return the data and a
   * version (typically getVersion(sessionID) captured at read time).
   *
   * Loader result is cached unless the cache is disabled or subscription is
   * unhealthy — in which case we still run the loader and return its result
   * but skip memoization (per I-3 do not serve stale values when we cannot
   * trust invalidation).
   */
  export async function get<T>(
    key: string,
    sessionID: string,
    loader: () => Promise<{ data: T; version: number }>,
  ): Promise<{ data: T; version: number; hit: boolean }> {
    const { enabled, ttlMs, max } = await currentCap()
    if (!enabled) {
      const start = now()
      const { data, version } = await loader()
      misses += 1
      void Bus.publish(Event.Miss, { key, sessionID, durationMs: now() - start })
      return { data, version, hit: false }
    }

    const existing = entries.get(key) as Entry<T> | undefined
    if (existing) {
      const age = now() - existing.createdAt
      if (age <= ttlMs) {
        // LRU touch: re-insert to move to the tail.
        entries.delete(key)
        existing.accessAt = now()
        entries.set(key, existing)
        hits += 1
        void Bus.publish(Event.Hit, { key, sessionID })
        return { data: existing.data, version: existing.version, hit: true }
      }
      // TTL expired.
      entries.delete(key)
      evictions += 1
      void Bus.publish(Event.Evicted, { key, sessionID, reason: "ttl" })
    }

    const start = now()
    const { data, version } = await loader()
    const durationMs = now() - start
    misses += 1
    void Bus.publish(Event.Miss, { key, sessionID, durationMs })

    if (!subscriptionAlive) {
      // I-3: do not memoize when we cannot trust invalidation.
      return { data, version, hit: false }
    }

    const entry: Entry<T> = { data, version, createdAt: now(), accessAt: now() }
    entries.set(key, entry)
    await enforceCapacity(max)
    return { data, version, hit: false }
  }

  export function invalidate(sessionID: string, triggeringEventType: string): number {
    let dropped = 0
    const sessionExact = `session:${sessionID}`
    const sessionSub = `session:${sessionID}:`
    const messagesPrefix = `messages:${sessionID}:`
    for (const key of Array.from(entries.keys())) {
      if (key === sessionExact || key.startsWith(sessionSub) || key.startsWith(messagesPrefix)) {
        entries.delete(key)
        dropped += 1
      }
    }
    invalidations += 1
    void Bus.publish(Event.Invalidated, { sessionID, triggeringEventType, keysDropped: dropped })
    return dropped
  }

  export function forgetSession(sessionID: string): void {
    invalidate(sessionID, Session.Event.Deleted.type)
    versions.delete(sessionID)
  }

  export function stats(): CacheStats {
    const totalOps = hits + misses
    const hitRate = totalOps === 0 ? 0 : hits / totalOps
    const missRate = totalOps === 0 ? 0 : misses / totalOps
    return {
      entries: entries.size,
      hitRate,
      missRate,
      invalidationCount: invalidations,
      evictionCount: evictions,
      subscriptionAlive,
    }
  }

  /**
   * Register bus subscribers for invalidation. Safe to call multiple times;
   * idempotent. Subscription failure is loud per I-3.
   */
  export function registerInvalidationSubscriber(): void {
    if (unsubscribers.length > 0) return
    try {
      unsubscribers.push(
        Bus.subscribeGlobal(MessageV2.Event.Updated.type, 0, (event) => {
          const sid = (event.properties as { info?: { sessionID?: string } }).info?.sessionID
          if (sid) {
            bumpVersion(sid)
            invalidate(sid, MessageV2.Event.Updated.type)
          }
        }),
      )
      unsubscribers.push(
        Bus.subscribeGlobal(MessageV2.Event.Removed.type, 0, (event) => {
          const sid = (event.properties as { sessionID?: string }).sessionID
          if (sid) {
            bumpVersion(sid)
            invalidate(sid, MessageV2.Event.Removed.type)
          }
        }),
      )
      unsubscribers.push(
        Bus.subscribeGlobal(MessageV2.Event.PartUpdated.type, 0, (event) => {
          const sid = (event.properties as { part?: { sessionID?: string } }).part?.sessionID
          if (sid) {
            bumpVersion(sid)
            invalidate(sid, MessageV2.Event.PartUpdated.type)
          }
        }),
      )
      unsubscribers.push(
        Bus.subscribeGlobal(MessageV2.Event.PartRemoved.type, 0, (event) => {
          const sid = (event.properties as { sessionID?: string }).sessionID
          if (sid) {
            bumpVersion(sid)
            invalidate(sid, MessageV2.Event.PartRemoved.type)
          }
        }),
      )
      unsubscribers.push(
        Bus.subscribeGlobal(Session.Event.Created.type, 0, (event) => {
          const sid = (event.properties as { info?: { id?: string } }).info?.id
          if (sid) {
            bumpVersion(sid)
            invalidate(sid, Session.Event.Created.type)
          }
        }),
      )
      unsubscribers.push(
        Bus.subscribeGlobal(Session.Event.Updated.type, 0, (event) => {
          const sid = (event.properties as { info?: { id?: string } }).info?.id
          if (sid) {
            bumpVersion(sid)
            invalidate(sid, Session.Event.Updated.type)
          }
        }),
      )
      unsubscribers.push(
        Bus.subscribeGlobal(Session.Event.Deleted.type, 0, (event) => {
          const sid = (event.properties as { info?: { id?: string } }).info?.id
          if (sid) {
            // I-4: drop counter entirely on deletion so next access is version 0.
            forgetSession(sid)
          }
        }),
      )
      subscriptionAlive = true
      registerCacheStatsProvider(stats)
      log.info("session-cache subscriptions registered", { count: unsubscribers.length })
    } catch (error) {
      subscriptionAlive = false
      log.warn("session-cache subscription failed", {
        error: error instanceof Error ? error.message : String(error),
      })
      // Still register stats so /cache/health reflects the degraded state.
      registerCacheStatsProvider(stats)
    }
  }

  /**
   * For tests: clear all state and unsubscribe.
   */
  export function resetForTesting(): void {
    for (const unsub of unsubscribers) {
      try {
        unsub()
      } catch {
        // unsubscribe failure during teardown is not significant
      }
    }
    unsubscribers = []
    entries.clear()
    versions.clear()
    hits = 0
    misses = 0
    invalidations = 0
    evictions = 0
    subscriptionAlive = false
  }

  /**
   * Override subscriptionAlive for tests that want to simulate wiring failure
   * without actually throwing inside subscribeGlobal.
   */
  export function setSubscriptionAliveForTesting(alive: boolean): void {
    subscriptionAlive = alive
  }
}
