import z from "zod"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { Identifier } from "@/id/id"
import type { ProviderBillingMode } from "@/provider/billing-mode"

export type SkillLayerEntry = {
  name: string
  content: string
  purpose: string
  keepRules: string[]
  loadedAt: number
  lastUsedAt: number
  runtimeState: "active" | "idle" | "sticky" | "summarized" | "unloaded"
  desiredState: "full" | "summary" | "absent"
  pinned: boolean
  lastReason: string
  residue?: SkillLayerResidue
}

export type SkillLayerResidue = {
  skillName: string
  purpose: string
  keepRules: string[]
  lastReason: string
  loadedAt: number
  lastUsedAt: number
}

const registry = new Map<string, Map<string, SkillLayerEntry>>()

const IDLE_SUMMARY_MS = 10 * 60 * 1000
const IDLE_UNLOAD_MS = 30 * 60 * 1000

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
    SkillLayerRegistry.clear(evt.properties.info.id)
  })
}

export namespace SkillLayerRegistry {
  function requireSessionRegistry(sessionID: string) {
    const sessionRegistry = registry.get(sessionID)
    if (!sessionRegistry) {
      throw new Error(`skill layer session registry missing: ${sessionID}`)
    }
    return sessionRegistry
  }

  function requireEntry(sessionID: string, name: string) {
    const sessionRegistry = requireSessionRegistry(sessionID)
    const entry = sessionRegistry.get(name)
    if (!entry) {
      throw new Error(`skill layer entry missing: ${name}`)
    }
    return entry
  }

  export function recordLoaded(
    sessionID: string,
    name: string,
    input: {
      content: string
      purpose?: string
      keepRules?: string[]
      now?: number
    },
  ) {
    ensureSubscribed()
    const now = input.now ?? Date.now()
    let sessionRegistry = registry.get(sessionID)
    if (!sessionRegistry) {
      sessionRegistry = new Map<string, SkillLayerEntry>()
      registry.set(sessionID, sessionRegistry)
    }
    const current = sessionRegistry.get(name)
    sessionRegistry.set(name, {
      name,
      content: input.content,
      purpose: input.purpose?.trim() || "skill_runtime_layer",
      keepRules: input.keepRules ?? current?.keepRules ?? [],
      loadedAt: current?.loadedAt ?? now,
      lastUsedAt: now,
      runtimeState: current?.pinned ? "sticky" : "active",
      desiredState: "full",
      pinned: current?.pinned ?? false,
      lastReason: "loaded",
      residue: undefined,
    })
  }

  export function recordUsed(sessionID: string, name: string, reason = "used", now = Date.now()) {
    const entry = requireEntry(sessionID, name)
    entry.lastUsedAt = now
    entry.lastReason = reason
    entry.desiredState = "full"
    entry.runtimeState = entry.pinned ? "sticky" : "active"
    entry.residue = undefined
  }

  export function pin(sessionID: string, name: string, now = Date.now()) {
    const entry = requireEntry(sessionID, name)
    entry.pinned = true
    entry.runtimeState = "sticky"
    entry.desiredState = "full"
    entry.lastUsedAt = now
    entry.lastReason = "pinned"
    entry.residue = undefined
  }

  export function unpin(sessionID: string, name: string) {
    const entry = requireEntry(sessionID, name)
    entry.pinned = false
    entry.runtimeState = "idle"
    entry.lastReason = "unpinned"
  }

  export function setDesiredState(
    sessionID: string,
    name: string,
    input: {
      desiredState: SkillLayerEntry["desiredState"]
      lastReason: string
      now?: number
    },
  ) {
    const entry = registry.get(sessionID)?.get(name)
    if (!entry) {
      throw new Error(`skill layer entry missing: ${name}`)
    }
    const now = input.now ?? Date.now()
    entry.desiredState = input.desiredState
    entry.lastReason = input.lastReason
    if (input.desiredState === "full") {
      entry.runtimeState = entry.pinned ? "sticky" : "active"
      entry.lastUsedAt = now
      entry.residue = undefined
      return
    }
    if (input.desiredState === "summary") {
      entry.runtimeState = "summarized"
      entry.residue = buildResidue(entry, input.lastReason)
      return
    }
    entry.runtimeState = "unloaded"
    entry.residue = buildResidue(entry, input.lastReason)
  }

  export function listForInjection(
    sessionID: string,
    input: {
      billingMode: ProviderBillingMode
      latestUserText?: string
      now?: number
    },
  ) {
    const now = input.now ?? Date.now()
    const sessionRegistry = registry.get(sessionID)
    if (!sessionRegistry) return []

    const latestUserText = input.latestUserText?.toLowerCase() ?? ""

    for (const entry of sessionRegistry.values()) {
      const relevanceHits = [entry.name, entry.purpose, ...entry.keepRules]
        .map((x) => x.toLowerCase())
        .filter((x) => x.length > 0)
      const relevant = relevanceHits.some((token) => latestUserText.includes(token))

      if (relevant) {
        entry.runtimeState = entry.pinned ? "sticky" : "active"
        entry.desiredState = "full"
        entry.lastReason = "relevance_keep_full"
        entry.lastUsedAt = now
        entry.residue = undefined
        continue
      }

      if (entry.pinned) {
        entry.runtimeState = "sticky"
        entry.desiredState = "full"
        entry.lastReason = "session_pinned_keep_full"
        entry.residue = undefined
        continue
      }

      if (input.billingMode !== "token") {
        entry.runtimeState = "active"
        entry.desiredState = "full"
        entry.lastReason =
          input.billingMode === "unknown" ? "billing_unknown_fail_closed_keep_full" : "request_billed_keep_full"
        entry.residue = undefined
        continue
      }

      const idleMs = now - entry.lastUsedAt
      if (idleMs >= IDLE_UNLOAD_MS) {
        entry.runtimeState = "unloaded"
        entry.desiredState = "absent"
        entry.lastReason = "idle_unload"
        entry.residue = buildResidue(entry, entry.lastReason)
        continue
      }

      if (idleMs >= IDLE_SUMMARY_MS) {
        entry.runtimeState = "summarized"
        entry.desiredState = "summary"
        entry.lastReason = "idle_summarize"
        entry.residue = buildResidue(entry, entry.lastReason)
        continue
      }

      entry.runtimeState = "active"
      entry.desiredState = "full"
      entry.lastReason = "recently_used"
      entry.residue = undefined
    }

    return list(sessionID)
  }

  export function list(sessionID: string) {
    return Array.from(registry.get(sessionID)?.values() ?? []).sort((a, b) => a.name.localeCompare(b.name))
  }

  export function peek(sessionID: string, name: string): SkillLayerEntry | undefined {
    return registry.get(sessionID)?.get(name)
  }

  export function clear(sessionID: string) {
    registry.delete(sessionID)
  }

  export function reset() {
    registry.clear()
  }
}

function buildResidue(entry: SkillLayerEntry, lastReason: string): SkillLayerResidue {
  return {
    skillName: entry.name,
    purpose: entry.purpose,
    keepRules: entry.keepRules,
    lastReason,
    loadedAt: entry.loadedAt,
    lastUsedAt: entry.lastUsedAt,
  }
}
