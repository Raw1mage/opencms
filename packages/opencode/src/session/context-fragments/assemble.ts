/**
 * Bundle assembler — fragment list → developer / user ResponseItems.
 *
 * Mirrors upstream codex-cli's `build_initial_context()` output shape
 * (refs/codex/codex-rs/core/src/session/mod.rs:2553-2761):
 *
 *   1. ONE bundled developer-role item containing all developer fragments
 *      (RoleIdentity, OpencodeProtocolInstructions, AppsInstructions,
 *      AvailableSkillsInstructions, ...)
 *   2. ONE bundled user-role item containing all user fragments
 *      (UserInstructions×N, EnvironmentContext, SkillInstructions×N, ...)
 *
 * Fragments preserve insertion order within each role. Empty bodies and
 * id collisions are handled per `fragment.ts` contract.
 */

import { renderFragment } from "./fragment"
import type { ContextFragment } from "./fragment"

export interface BundledMessage {
  role: "user" | "developer"
  /** Joined wire text for this bundle. */
  text: string
  /** Ordered fragment ids contributing to this bundle (telemetry / debug). */
  fragmentIds: string[]
}

export interface AssembleResult {
  developerBundle: BundledMessage | null
  userBundle: BundledMessage | null
}

/** Separator between fragments within a single bundle. */
const FRAGMENT_SEP = "\n\n"

/**
 * Group fragments by role, dedup by id, render each, join with separator.
 * Throws on id collision (per `errors.md` E3 contract). Returns null for
 * a role when its fragment list is empty (caller skips emitting the item).
 */
export function assembleBundles(fragments: ContextFragment[]): AssembleResult {
  const seenIds = new Set<string>()
  const developer: ContextFragment[] = []
  const user: ContextFragment[] = []

  for (const f of fragments) {
    if (seenIds.has(f.id)) {
      throw new Error(
        `context-fragments.assemble: duplicate fragment id "${f.id}" — registry MUST dedup before reaching the assembler (errors.md E3).`,
      )
    }
    seenIds.add(f.id)
    if (f.role === "developer") developer.push(f)
    else if (f.role === "user") user.push(f)
    else {
      // exhaustiveness guard
      const _exhaustive: never = f.role
      throw new Error(`context-fragments.assemble: unknown role on fragment "${f.id}": ${String(_exhaustive)}`)
    }
  }

  return {
    developerBundle: buildBundle("developer", developer),
    userBundle: buildBundle("user", user),
  }
}

function buildBundle(role: "developer" | "user", fragments: ContextFragment[]): BundledMessage | null {
  const rendered: { id: string; text: string }[] = []
  for (const f of fragments) {
    const text = renderFragment(f)
    if (text.length === 0) continue // empty body or empty wrapper — drop
    rendered.push({ id: f.id, text })
  }
  if (rendered.length === 0) return null

  return {
    role,
    text: rendered.map((r) => r.text).join(FRAGMENT_SEP),
    fragmentIds: rendered.map((r) => r.id),
  }
}
