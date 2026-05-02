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
  /**
   * DD-9 (specs/prompt-cache-and-compaction-hardening): set of anchorIds that
   * pinned this entry. `pinForAnchor` adds; `unpinByAnchor` removes. The skill
   * remains pinned as long as the set is non-empty. Allows multiple concurrent
   * anchors to pin the same skill without stomping each other on supersede.
   */
  pinnedByAnchors?: Set<string>
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

  /**
   * DD-9: pin a skill on behalf of a compaction anchor. Multiple anchors can
   * pin independently; the skill remains pinned until every anchor that
   * pinned it has been superseded (via {@link unpinByAnchor}).
   */
  export function pinForAnchor(
    sessionID: string,
    name: string,
    anchorId: string,
    reason = "referenced-by-anchor",
    now = Date.now(),
  ) {
    const entry = requireEntry(sessionID, name)
    if (!entry.pinnedByAnchors) entry.pinnedByAnchors = new Set()
    entry.pinnedByAnchors.add(anchorId)
    entry.pinned = true
    entry.runtimeState = "sticky"
    entry.desiredState = "full"
    entry.lastUsedAt = now
    entry.lastReason = `${reason}:${anchorId}`
    entry.residue = undefined
  }

  /**
   * DD-9: when a new anchor supersedes an old one, unpin every entry that the
   * old anchor previously pinned. The entry remains pinned if any other anchor
   * still pins it. Called from compaction.run before the new anchor write.
   */
  export function unpinByAnchor(sessionID: string, anchorId: string): string[] {
    const sessionRegistry = registry.get(sessionID)
    if (!sessionRegistry) return []
    const released: string[] = []
    for (const entry of sessionRegistry.values()) {
      if (!entry.pinnedByAnchors?.has(anchorId)) continue
      entry.pinnedByAnchors.delete(anchorId)
      if (entry.pinnedByAnchors.size === 0) {
        // Manually-pinned entries (via `pin`) keep entry.pinned=true via the
        // set being absent; we only flip to false when the set is empty AND
        // the original pin came from a pinForAnchor (we can't distinguish
        // origin perfectly, so the current rule is: empty anchor set →
        // unpin. If the user explicitly called pin() afterwards they should
        // call pin() again or the unpinByAnchor caller must coordinate.).
        entry.pinned = false
        entry.runtimeState = "idle"
        entry.lastReason = `unpinned-by-anchor-supersede:${anchorId}`
        released.push(entry.name)
      } else {
        entry.lastReason = `unpinned-partial-by-anchor:${anchorId}`
      }
    }
    return released
  }

  /**
   * DD-9 helper: scan a text body for skill name references using simple
   * word-boundary substring match. Returns the subset of `knownNames` that
   * appear as standalone tokens in the text.
   */
  export function scanReferences(text: string, knownNames: ReadonlyArray<string>): string[] {
    if (!text || knownNames.length === 0) return []
    const matched: string[] = []
    for (const name of knownNames) {
      // Escape regex metacharacters in skill names (most are kebab-case).
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      const re = new RegExp(`(^|[^A-Za-z0-9_-])${escaped}(?![A-Za-z0-9_-])`, "i")
      if (re.test(text)) matched.push(name)
    }
    return matched
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
