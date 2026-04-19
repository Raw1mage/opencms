import z from "zod"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { Identifier } from "@/id/id"
import { Log } from "@/util/log"
import { RuntimeEventService } from "@/system/runtime-event-service"

const log = Log.create({ service: "capability-layer" })

export const CapabilityLayerName = z.enum(["agents_md", "driver", "skill_content", "enablement"])
export type CapabilityLayerName = z.infer<typeof CapabilityLayerName>

export const CAPABILITY_LAYER_ORDER: ReadonlyArray<CapabilityLayerName> = [
  "agents_md",
  "driver",
  "skill_content",
  "enablement",
]

export type AgentsMdLayer = {
  text: string
  sources: string[]
}

export type DriverLayer = {
  text: string
  providerId: string
  modelID?: string
}

export type SkillContentLayer = {
  pinnedSkills: string[]
  renderedText: string
  missingSkills: string[]
}

export type EnablementLayer = {
  text: string
  version?: string
}

export type LayerBundle = {
  agents_md: AgentsMdLayer
  driver?: DriverLayer
  skill_content: SkillContentLayer
  enablement?: EnablementLayer
}

export type CapabilityLayerCacheEntry = {
  sessionID: string
  epoch: number
  createdAt: number
  layers: LayerBundle
}

export type ReinjectOutcome = {
  sessionID: string
  epoch: number
  layers: CapabilityLayerName[]
  pinnedSkills: string[]
  missingSkills: string[]
  failures: Array<{ layer: CapabilityLayerName; error: string }>
  usedFallbackEpoch?: number
}

/**
 * Contract for loading the capability layer from authoritative sources.
 * Phase 3 + Phase 4 wire the real implementation (reads AGENTS.md / driver /
 * skills / enablement). Phase 2 ships with no default loader so tests inject
 * mocks and production wiring fills in later.
 */
export interface CapabilityLayerLoader {
  load(input: { sessionID: string; epoch: number }): Promise<LayerBundle>
}

let activeLoader: CapabilityLayerLoader | null = null

/** Register the capability-layer loader. Phase 3 calls this at daemon startup. */
export function setCapabilityLayerLoader(loader: CapabilityLayerLoader | null) {
  activeLoader = loader
}

/** Retain at most N entries per session (current + previous for R3 fallback). */
const MAX_ENTRIES_PER_SESSION = 2

const cache = new Map<string, Map<number, CapabilityLayerCacheEntry>>()

const SessionDeletedEvent = BusEvent.define(
  "session.deleted",
  z.object({
    info: z.object({
      id: Identifier.schema("session"),
    }),
  }),
)

let _subscribed = false
function ensureSubscribed() {
  if (_subscribed) return
  _subscribed = true
  Bus.subscribe(SessionDeletedEvent, (evt) => {
    CapabilityLayer.clearForSession(evt.properties.info.id)
  })
}

async function appendEventSafe(input: {
  sessionID: string
  level: "info" | "warn" | "error"
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
    log.warn("[capability-layer] failed to append event", {
      sessionID: input.sessionID,
      eventType: input.eventType,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

function layerNamesFromBundle(bundle: LayerBundle): CapabilityLayerName[] {
  const out: CapabilityLayerName[] = []
  for (const name of CAPABILITY_LAYER_ORDER) {
    if (bundle[name] !== undefined) out.push(name)
  }
  return out
}

function pruneSessionCache(sessionID: string) {
  const sessionCache = cache.get(sessionID)
  if (!sessionCache) return
  if (sessionCache.size <= MAX_ENTRIES_PER_SESSION) return
  const sortedEpochs = Array.from(sessionCache.keys()).sort((a, b) => a - b)
  // Drop oldest until we fit within the budget.
  while (sortedEpochs.length > MAX_ENTRIES_PER_SESSION) {
    const dropped = sortedEpochs.shift()!
    sessionCache.delete(dropped)
  }
}

function findFallbackEntry(
  sessionID: string,
  maxEpochExclusive: number,
): CapabilityLayerCacheEntry | undefined {
  const sessionCache = cache.get(sessionID)
  if (!sessionCache) return undefined
  let best: CapabilityLayerCacheEntry | undefined
  for (const entry of sessionCache.values()) {
    if (entry.epoch >= maxEpochExclusive) continue
    if (!best || entry.epoch > best.epoch) best = entry
  }
  return best
}

export namespace CapabilityLayer {
  /** Cheap synchronous lookup: returns the entry if one exists at (sessionID, epoch). */
  export function peek(sessionID: string, epoch: number): CapabilityLayerCacheEntry | undefined {
    return cache.get(sessionID)?.get(epoch)
  }

  /**
   * Resolve the capability layer for (sessionID, epoch). Cache hit returns in
   * memory; cache miss triggers {@link reinject}. On reinject failure, falls
   * back to the most recent previous epoch's entry (with a warn log) so the
   * session can keep running in degraded mode (R3 mitigation).
   */
  export async function get(
    sessionID: string,
    epoch: number,
  ): Promise<CapabilityLayerCacheEntry> {
    ensureSubscribed()
    const hit = peek(sessionID, epoch)
    if (hit) return hit
    const outcome = await reinject(sessionID, epoch)
    const after = peek(sessionID, epoch)
    if (after) return after
    // Reinject failed and no entry was written at the requested epoch. Try
    // previous-epoch fallback for the session.
    const fallback = findFallbackEntry(sessionID, epoch)
    if (fallback) {
      log.warn("[capability-layer] fallback to previous epoch cache", {
        sessionID,
        currentEpoch: epoch,
        fallbackEpoch: fallback.epoch,
        failures: outcome.failures,
      })
      return fallback
    }
    throw new Error(
      `[capability-layer] no cache and no fallback available for ${sessionID}@${epoch}; failures=${outcome.failures
        .map((f) => `${f.layer}:${f.error}`)
        .join(",")}`,
    )
  }

  /**
   * Force a fresh load of the capability layer for (sessionID, epoch) via the
   * registered loader. On success, writes the entry into cache (keeping at most
   * {@link MAX_ENTRIES_PER_SESSION} entries per session) and emits
   * `capability_layer.refreshed`. On failure, leaves the existing cache intact
   * (does NOT overwrite) and emits `capability_layer.refresh_failed`.
   */
  export async function reinject(sessionID: string, epoch: number): Promise<ReinjectOutcome> {
    ensureSubscribed()
    const failures: ReinjectOutcome["failures"] = []
    const started = Date.now()
    if (!activeLoader) {
      const message = "no loader registered (setCapabilityLayerLoader not called)"
      log.error("[capability-layer] reinject failed", {
        sessionID,
        epoch,
        failingLayer: "agents_md",
        error: message,
        keptPreviousCache: cache.get(sessionID)?.size ?? 0 > 0,
      })
      await appendEventSafe({
        sessionID,
        level: "error",
        domain: "anomaly",
        eventType: "capability_layer.refresh_failed",
        anomalyFlags: ["capability_layer_refresh_failed"],
        payload: {
          epoch,
          failingLayer: "agents_md",
          error: message,
          keptPreviousCache: (cache.get(sessionID)?.size ?? 0) > 0,
        },
      })
      return {
        sessionID,
        epoch,
        layers: [],
        pinnedSkills: [],
        missingSkills: [],
        failures: [{ layer: "agents_md", error: message }],
      }
    }

    let bundle: LayerBundle
    try {
      bundle = await activeLoader.load({ sessionID, epoch })
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      const failingLayer: CapabilityLayerName = "agents_md" // default blame — refined when loader provides richer error
      failures.push({ layer: failingLayer, error })
      const keptPreviousCache = (cache.get(sessionID)?.size ?? 0) > 0
      log.error("[capability-layer] reinject failed", {
        sessionID,
        epoch,
        failingLayer,
        error,
        keptPreviousCache,
      })
      await appendEventSafe({
        sessionID,
        level: "error",
        domain: "anomaly",
        eventType: "capability_layer.refresh_failed",
        anomalyFlags: ["capability_layer_refresh_failed"],
        payload: {
          epoch,
          failingLayer,
          error,
          keptPreviousCache,
        },
      })
      return {
        sessionID,
        epoch,
        layers: [],
        pinnedSkills: [],
        missingSkills: [],
        failures,
      }
    }

    const entry: CapabilityLayerCacheEntry = {
      sessionID,
      epoch,
      createdAt: Date.now(),
      layers: bundle,
    }
    let sessionCache = cache.get(sessionID)
    if (!sessionCache) {
      sessionCache = new Map()
      cache.set(sessionID, sessionCache)
    }
    sessionCache.set(epoch, entry)
    pruneSessionCache(sessionID)

    const layers = layerNamesFromBundle(bundle)
    const pinnedSkills = bundle.skill_content?.pinnedSkills ?? []
    const missingSkills = bundle.skill_content?.missingSkills ?? []
    log.info("[capability-layer] reinject done", {
      sessionID,
      epoch,
      layers,
      pinnedSkills,
      missingSkills,
      durationMs: Date.now() - started,
    })
    await appendEventSafe({
      sessionID,
      level: "info",
      domain: "workflow",
      eventType: "capability_layer.refreshed",
      payload: {
        epoch,
        layers,
        pinnedSkills,
        missingSkills,
      },
    })
    return {
      sessionID,
      epoch,
      layers,
      pinnedSkills,
      missingSkills,
      failures: [],
    }
  }

  /** Drop all cache entries for a session. Called on session.deleted. */
  export function clearForSession(sessionID: string) {
    cache.delete(sessionID)
  }

  /** Full reset — tests only. */
  export function reset() {
    cache.clear()
  }

  /** Enumerate cache entries for a session (ops + test). */
  export function listForSession(sessionID: string): CapabilityLayerCacheEntry[] {
    const sessionCache = cache.get(sessionID)
    if (!sessionCache) return []
    return Array.from(sessionCache.values()).sort((a, b) => a.epoch - b.epoch)
  }
}

export const CAPABILITY_LAYER_INTERNAL = {
  MAX_ENTRIES_PER_SESSION,
} as const
