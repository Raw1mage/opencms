/**
 * Fragment cache policy taxonomy.
 *
 * Names the four cadences at which a prompt-injected fragment may be
 * recomputed. These names are emitted into prompt.telemetry payloads
 * under `blocks[].policy`; they are NOT (yet) enforced by a runtime
 * cache key. M6 of plans/session_rebind-procedure-revision/ introduces
 * the taxonomy + relabel; the cache-key inclusion (M6-5) is deferred to
 * Phase D where it can land as a single coordinated change.
 *
 * The four values:
 *
 *   - `always_on`            — Static system layer. Computed at
 *                              session creation; never recomputed.
 *                              Lowest cache churn.
 *   - `conversation_stable`  — Computed at session creation; survives
 *                              all chain-breaking events. Used for
 *                              fragments whose content depends solely
 *                              on the conversation identity (e.g.
 *                              role_identity, opencode_protocol,
 *                              README, cwd, today's date).
 *   - `chain_stable`         — Recomputed on every chain-identity reset
 *                              (rebind / rotate / cross-provider /
 *                              fork / daemon restart). Used for
 *                              fragments whose content depends on the
 *                              current chain state (e.g. amnesia_notice
 *                              after compaction, environment_context
 *                              after capability refresh).
 *   - `once_after_chain_break` — Injected exactly once on the outbound
 *                                  following a chain-breaking event,
 *                                  then cleared. Used by
 *                                  chain_init_notice via
 *                                  PendingInjectionStore.
 *
 * Two legacy labels remain in use elsewhere and are preserved for
 * backward compatibility during the rollout:
 *
 *   - `decay`                — T2 skill summarisation; recomputed when
 *                              underlying skill state changes.
 *   - `dynamic`              — Per-turn trailing content (images,
 *                              attachments).
 *
 * These will continue to appear in telemetry alongside the new
 * canonical values until a follow-up plan unifies them.
 */

import { z } from "zod"

export const FragmentPolicySchema = z.enum([
  "always_on",
  "conversation_stable",
  "chain_stable",
  "once_after_chain_break",
  // legacy labels — retained for backward compatibility:
  "decay",
  "dynamic",
])

export type FragmentPolicy = z.infer<typeof FragmentPolicySchema>

/**
 * Canonical policy values introduced by session/rebind-procedure-revision.
 * Useful for migration audit: any code referencing the legacy
 * `"session_stable"` string should map to one of these.
 */
export const FRAGMENT_POLICY_CANONICAL = {
  ALWAYS_ON: "always_on" as const,
  CONVERSATION_STABLE: "conversation_stable" as const,
  CHAIN_STABLE: "chain_stable" as const,
  ONCE_AFTER_CHAIN_BREAK: "once_after_chain_break" as const,
} as const

/**
 * Legacy label kept around for diff/audit purposes. New code MUST NOT
 * emit this; existing emit sites are migrated to `conversation_stable`
 * (chain-independent) or `chain_stable` (chain-dependent) per audit.
 *
 * @deprecated migrated 2026-05-12; remove after one release cycle.
 */
export const LEGACY_SESSION_STABLE_LABEL = "session_stable"
