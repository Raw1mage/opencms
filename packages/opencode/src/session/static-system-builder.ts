// Phase B B.3 (DD-12 + DD-15 + DD-16 of specs/prompt-cache-and-compaction-hardening).
//
// Builder for the pure-static system block. Concatenates the seven static
// layers in DD-12 fixed order and computes a sha256 hash for cache-miss
// diagnostic comparison.
//
// Pure function: same StaticSystemTuple → same { text, hash }. Cache hits
// across turns require this byte-determinism (DD-3 prerequisite for BP1).
//
// DD-15: tuple includes `family` and `accountId` as first-class fields so
// driver/auth differences across accounts in the same family are reflected
// in the hash key. Tuple resolver lives in caller (llm.ts) — this module
// only consumes a fully-resolved tuple and does NOT call provider/auth APIs
// itself, satisfying DD-16 by construction (no boundary to violate).

import { createHash } from "crypto"
import { Account } from "../account"

const CRITICAL_OPERATIONAL_BOUNDARY = "\n\n--- CRITICAL OPERATIONAL BOUNDARY ---\n\n"

/**
 * Layers L1..L8 (excluding L4 enablement and L9 skill, which are dynamic
 * and live in the preface or in the user turn) as already-resolved strings.
 * Caller is responsible for resolving each layer; the builder only joins.
 */
export interface StaticSystemLayers {
  /** L1 Driver — provider-specific prompt (claude-code / beast / qwen / ...). */
  driver: string
  /** L2 Agent — agent-specific prompt (build / coding / review / ...). */
  agent: string
  /** L3c AGENTS.md — project + global instruction tactics. */
  agentsMd: string
  /** L5 user-system — input.user.system passthrough. */
  userSystem: string
  /** L7 SYSTEM.md — constitution. */
  systemMd: string
  /** L8 Identity — Main Agent vs Subagent role marker. */
  identity: string
}

/**
 * Identity tuple for cache key. Two distinct turns of the same session
 * with identical tuple must produce byte-equal output.
 */
export interface StaticSystemTuple {
  /** DD-15: family is first-class (claude / codex / gemini / ...). */
  family: string
  /** DD-15: accountId distinguishes per-account driver/auth differences. */
  accountId: string | undefined
  modelId: string
  agentName: string
  role: "main" | "subagent"
  layers: StaticSystemLayers
}

export interface StaticSystemBlock {
  text: string
  /** sha256 hex of `text`. Fed into cache-miss-diagnostic.recordSystemBlockHash. */
  hash: string
  /** The tuple that produced this block, kept for debug / telemetry. */
  tuple: StaticSystemTuple
}

/**
 * Build the static system block. Pure function — same input bytes → same
 * output bytes.
 *
 * Order is locked to DD-12: L1 → L2 → L3c → L5 → L6 → L7 → L8.
 * Empty-string layers are skipped (don't emit blank sections) but the order
 * of the remaining layers is preserved.
 */
export function buildStaticBlock(tuple: StaticSystemTuple): StaticSystemBlock {
  const { layers } = tuple
  const sections: string[] = []
  if (layers.driver) sections.push(layers.driver)
  if (layers.agent) sections.push(layers.agent)
  if (layers.agentsMd) sections.push(layers.agentsMd)
  if (layers.userSystem) sections.push(layers.userSystem)
  // L6: BOUNDARY is always present even when surrounding layers are empty,
  // so the structural separation between context-layer (1-5) and authority-
  // layer (7-8) survives. This matches Phase A's behavior verbatim.
  sections.push(CRITICAL_OPERATIONAL_BOUNDARY.trim())
  if (layers.systemMd) sections.push(layers.systemMd)
  if (layers.identity) sections.push(layers.identity)
  const text = sections.join("\n")
  const hash = createHash("sha256").update(text).digest("hex")
  return { text, hash, tuple }
}

/**
 * Resolve the family slug for a given model.providerId by consulting the
 * canonical Account.knownFamilies list. Throws if the providerId cannot be
 * mapped — DD-16 + AGENTS.md "no silent fallback".
 *
 * Caller obtains knownFamilies via `await Account.knownFamilies()` once
 * per turn (cheap; cached upstream) and threads it in.
 */
export function resolveFamily(providerId: string, knownFamilies: readonly string[]): string {
  const family = Account.resolveFamilyFromKnown(providerId, knownFamilies)
  if (!family) {
    throw new Error(
      `static-system-builder: cannot resolve family for providerId="${providerId}" against knownFamilies=[${knownFamilies.join(",")}]. ` +
        `This violates DD-16 (specs/prompt-cache-and-compaction-hardening). Check Account.knownFamilies() includes this provider.`,
    )
  }
  return family
}
