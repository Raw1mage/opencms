/**
 * Continuation events + classifier.
 *
 * Single source of truth for "what events break chain identity in
 * opencode, and what should happen for each (event-kind, provider-class)
 * pair." The classifier produces a `ContinuationDecision` of six boolean
 * flags that the procedure executor (`./run.ts`) consumes.
 *
 * See /plans/session_rebind-procedure-revision/design.md for the
 * canonical matrix and DD-1 through DD-12.
 *
 * Rule (DD-7 / DD-11): every event kind has an explicit decision per
 * provider class. Unknown event kinds throw — by design.
 */

import { z } from "zod"
import { NamedError } from "@opencode-ai/util/error"
import { classifyProvider, type ProviderChainClass } from "../../provider/chain-semantics"

// -------------------------------------------------------------------------
// ContinuationEvent discriminated union
// -------------------------------------------------------------------------

const SessionID = z.string()
const ProviderID = z.string()
const AccountID = z.string()
const ModelID = z.string()

export const ContinuationEventSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("account_switch"),
    sessionID: SessionID,
    previousAccountId: AccountID,
    accountId: AccountID,
    providerId: ProviderID,
  }),
  z.object({
    kind: z.literal("account_rotate"),
    sessionID: SessionID,
    previousAccountId: AccountID,
    accountId: AccountID,
    providerId: ProviderID,
    trigger: z.enum(["quota", "429", "manual"]),
  }),
  z.object({
    kind: z.literal("provider_switch"),
    sessionID: SessionID,
    previousProviderId: ProviderID,
    providerId: ProviderID,
  }),
  z.object({
    kind: z.literal("model_switch_same_family"),
    sessionID: SessionID,
    previousModelId: ModelID,
    modelId: ModelID,
    providerId: ProviderID,
  }),
  z.object({
    kind: z.literal("model_switch_cross_family"),
    sessionID: SessionID,
    previousModelId: ModelID,
    modelId: ModelID,
    providerId: ProviderID,
  }),
  z.object({
    kind: z.literal("session_fork"),
    sessionID: SessionID,
    parentSessionID: SessionID,
    providerId: ProviderID.optional(),
  }),
  z.object({
    kind: z.literal("session_resume_daemon_alive"),
    sessionID: SessionID,
    providerId: ProviderID.optional(),
  }),
  z.object({
    kind: z.literal("session_resume_after_daemon_restart"),
    sessionID: SessionID,
    providerId: ProviderID.optional(),
  }),
  z.object({
    kind: z.literal("capability_layer_refresh"),
    sessionID: SessionID,
    reason: z.string(),
    providerId: ProviderID.optional(),
  }),
  z.object({
    kind: z.literal("compaction_narrative"),
    sessionID: SessionID,
    anchorId: z.string(),
    providerId: ProviderID,
  }),
  z.object({
    kind: z.literal("compaction_cache_aware"),
    sessionID: SessionID,
    anchorId: z.string(),
    providerId: ProviderID,
  }),
  z.object({
    kind: z.literal("compaction_stall_recovery"),
    sessionID: SessionID,
    anchorId: z.string(),
    providerId: ProviderID,
  }),
  z.object({
    kind: z.literal("compaction_preemptive_daemon_restart"),
    sessionID: SessionID,
    anchorId: z.string(),
    providerId: ProviderID,
  }),
  z.object({
    kind: z.literal("compaction_server_side"),
    sessionID: SessionID,
    anchorId: z.string(),
    providerId: ProviderID,
  }),
  z.object({
    kind: z.literal("empty_response_recovery"),
    sessionID: SessionID,
    emptyRoundCount: z.number(),
    providerId: ProviderID.optional(),
  }),
  z.object({
    kind: z.literal("ws_reconnect"),
    sessionID: SessionID,
    providerId: ProviderID.optional(),
  }),
  z.object({
    kind: z.literal("subagent_spawn"),
    sessionID: SessionID,
    parentSessionID: SessionID,
    providerId: ProviderID.optional(),
  }),
  z.object({
    kind: z.literal("user_clear"),
    sessionID: SessionID,
    providerId: ProviderID.optional(),
  }),
  z.object({
    kind: z.literal("backend_failure_forced_resend"),
    sessionID: SessionID,
    classifier: z.enum(["ws_truncation", "server_failed", "ws_no_frames", "server_incomplete"]),
    providerId: ProviderID,
  }),
])

export type ContinuationEvent = z.infer<typeof ContinuationEventSchema>
export type ContinuationEventKind = ContinuationEvent["kind"]

// -------------------------------------------------------------------------
// ContinuationDecision — six boolean flags + the chain-break class label
// used to extend the session.rebind event payload.
// -------------------------------------------------------------------------

export type ChainBreakClass = "SS-break" | "SL-noop" | "capability-only" | "user-intent" | "preserved"

export interface ContinuationDecision {
  /** Should invalidateContinuationFamily run? */
  breaksChain: boolean
  /** Should commitment digest be captured before invalidation (DD-8 ordering)? */
  capturesDigest: boolean
  /** Should chain_stable fragments recompute on next prompt build? */
  recomputesChainStable: boolean
  /** Should chain-init-notice fragment be injected on next outbound? */
  injectsChainInit: boolean
  /** Should amnesia-notice fragment be injected on next outbound? */
  injectsAmnesia: boolean
  /** Should RebindEpoch.bumpEpoch fire? */
  bumpsRebindEpoch: boolean
  /** chainBreakClass marker for session.rebind event payload extension. */
  chainBreakClass: ChainBreakClass
  /** Reason marker for chain.init.skipped event when injectsChainInit=false. */
  skipReason?: SkipReason
}

export type SkipReason =
  | "user_clear"
  | "subagent_spawn"
  | "no_prior_chain"
  | "capability_only"
  | "ws_reconnect"
  | "sl_provider"
  | "server_side_compaction"

// -------------------------------------------------------------------------
// Decision helpers — keep cells declarative; one function per event kind.
// Each function returns a "shape" with provider-class-agnostic flags;
// `classify` applies the provider-class overlay.
// -------------------------------------------------------------------------

interface DecisionShape {
  capturesDigest: boolean
  recomputesChainStable: boolean
  injectsChainInit: boolean
  injectsAmnesia: boolean
  bumpsRebindEpoch: boolean
  /** If chain semantically must break for SS providers. SL providers always have breaksChain=false. */
  ssBreaks: boolean
  /** Chain break class label when SS provider; SL falls back to "SL-noop" automatically. */
  ssBreakClass: Extract<ChainBreakClass, "SS-break" | "capability-only" | "user-intent" | "preserved">
  /** SkipReason when injectsChainInit=false. */
  skipReason?: SkipReason
}

const SHAPE_BY_KIND: Record<ContinuationEventKind, DecisionShape> = {
  // E1a — account switch: physical chain break for SS providers; digest + init + epoch
  account_switch: {
    ssBreaks: true,
    capturesDigest: true,
    recomputesChainStable: true,
    injectsChainInit: true,
    injectsAmnesia: false,
    bumpsRebindEpoch: true,
    ssBreakClass: "SS-break",
  },

  // E1b — account auto-rotate: same as account_switch
  account_rotate: {
    ssBreaks: true,
    capturesDigest: true,
    recomputesChainStable: true,
    injectsChainInit: true,
    injectsAmnesia: false,
    bumpsRebindEpoch: true,
    ssBreakClass: "SS-break",
  },

  // E2a — provider switch: chain breaks regardless of source class
  // because the tool-call format and system prompt change. Both
  // injection flags set so the new provider's first turn lands correctly.
  provider_switch: {
    ssBreaks: true,
    capturesDigest: true,
    recomputesChainStable: true,
    injectsChainInit: true,
    injectsAmnesia: false,
    bumpsRebindEpoch: true,
    ssBreakClass: "SS-break",
  },

  // E2b — model switch same family: DD-4 conservative default = treat as break
  model_switch_same_family: {
    ssBreaks: true,
    capturesDigest: true,
    recomputesChainStable: true,
    injectsChainInit: true,
    injectsAmnesia: false,
    bumpsRebindEpoch: true,
    ssBreakClass: "SS-break",
  },

  // E2c — model switch cross-family: always break
  model_switch_cross_family: {
    ssBreaks: true,
    capturesDigest: true,
    recomputesChainStable: true,
    injectsChainInit: true,
    injectsAmnesia: false,
    bumpsRebindEpoch: true,
    ssBreakClass: "SS-break",
  },

  // E3 — session fork: child has no prior chain to mourn (DD-9)
  session_fork: {
    ssBreaks: false,
    capturesDigest: false,
    recomputesChainStable: false,
    injectsChainInit: false,
    injectsAmnesia: false,
    bumpsRebindEpoch: false,
    ssBreakClass: "preserved",
    skipReason: "no_prior_chain",
  },

  // E4a — session resume while daemon alive: chain id still in memory
  session_resume_daemon_alive: {
    ssBreaks: false,
    capturesDigest: false,
    recomputesChainStable: false,
    injectsChainInit: false,
    injectsAmnesia: false,
    bumpsRebindEpoch: true,
    ssBreakClass: "capability-only",
    skipReason: "capability_only",
  },

  // E4b — session resume after daemon restart: lastResponseId wiped
  session_resume_after_daemon_restart: {
    ssBreaks: true,
    capturesDigest: true,
    recomputesChainStable: true,
    injectsChainInit: true,
    injectsAmnesia: false,
    bumpsRebindEpoch: true,
    ssBreakClass: "SS-break",
  },

  // E5 — capability layer refresh: no chain break, epoch only (DD-12)
  capability_layer_refresh: {
    ssBreaks: false,
    capturesDigest: false,
    recomputesChainStable: true,
    injectsChainInit: false,
    injectsAmnesia: false,
    bumpsRebindEpoch: true,
    ssBreakClass: "capability-only",
    skipReason: "capability_only",
  },

  // E6 — narrative compaction: existing L3 amnesia path
  compaction_narrative: {
    ssBreaks: true,
    capturesDigest: true,
    recomputesChainStable: true,
    injectsChainInit: false,
    injectsAmnesia: true,
    bumpsRebindEpoch: true,
    ssBreakClass: "SS-break",
  },

  // E7a — cache-aware compaction: same shape
  compaction_cache_aware: {
    ssBreaks: true,
    capturesDigest: true,
    recomputesChainStable: true,
    injectsChainInit: false,
    injectsAmnesia: true,
    bumpsRebindEpoch: true,
    ssBreakClass: "SS-break",
  },

  // E7b — stall-recovery compaction
  compaction_stall_recovery: {
    ssBreaks: true,
    capturesDigest: true,
    recomputesChainStable: true,
    injectsChainInit: false,
    injectsAmnesia: true,
    bumpsRebindEpoch: true,
    ssBreakClass: "SS-break",
  },

  // E7c — pre-emptive compaction at daemon restart
  compaction_preemptive_daemon_restart: {
    ssBreaks: true,
    capturesDigest: true,
    recomputesChainStable: true,
    injectsChainInit: false,
    injectsAmnesia: true,
    bumpsRebindEpoch: true,
    ssBreakClass: "SS-break",
  },

  // E7d — server-side compaction (codex /responses/compact): chain preserved
  compaction_server_side: {
    ssBreaks: false,
    capturesDigest: false,
    recomputesChainStable: false,
    injectsChainInit: false,
    injectsAmnesia: false,
    bumpsRebindEpoch: false,
    ssBreakClass: "preserved",
    skipReason: "server_side_compaction",
  },

  // E8 — empty-response recovery: DD-10 keep invalidation + add notice
  empty_response_recovery: {
    ssBreaks: true,
    capturesDigest: true,
    recomputesChainStable: true,
    injectsChainInit: true,
    injectsAmnesia: false,
    bumpsRebindEpoch: true,
    ssBreakClass: "SS-break",
  },

  // E9 — WebSocket reconnect: chain id outlives socket
  ws_reconnect: {
    ssBreaks: false,
    capturesDigest: false,
    recomputesChainStable: false,
    injectsChainInit: false,
    injectsAmnesia: false,
    bumpsRebindEpoch: false,
    ssBreakClass: "preserved",
    skipReason: "ws_reconnect",
  },

  // E10 — subagent spawn: child fresh; parent untouched (DD-9)
  subagent_spawn: {
    ssBreaks: false,
    capturesDigest: false,
    recomputesChainStable: false,
    injectsChainInit: false,
    injectsAmnesia: false,
    bumpsRebindEpoch: false,
    ssBreakClass: "preserved",
    skipReason: "subagent_spawn",
  },

  // E11 — user /clear: user-aware reset; suppress notice (DD-9)
  user_clear: {
    ssBreaks: true,
    capturesDigest: false,
    recomputesChainStable: true,
    injectsChainInit: false,
    injectsAmnesia: false,
    bumpsRebindEpoch: true,
    ssBreakClass: "user-intent",
    skipReason: "user_clear",
  },

  // E12 — backend-failure forced re-send: DD-5
  backend_failure_forced_resend: {
    ssBreaks: true,
    capturesDigest: true,
    recomputesChainStable: true,
    injectsChainInit: true,
    injectsAmnesia: false,
    bumpsRebindEpoch: true,
    ssBreakClass: "SS-break",
  },
}

// -------------------------------------------------------------------------
// Classifier
// -------------------------------------------------------------------------

/**
 * Apply the event-shape × provider-class overlay to produce a final
 * ContinuationDecision.
 *
 * The overlay rule is simple but load-bearing:
 *   - For SL providers, breaksChain is always false (no chain to break)
 *     and chain-init injection is suppressed (no reasoning trace was
 *     ever held server-side to mourn).
 *   - For SS providers, the shape is applied verbatim.
 *   - For Hybrid providers (none today), the conservative path is taken:
 *     treat as SS-shaped break.
 *
 * Resolves provider class via `classifyProvider(event.providerId)` —
 * which throws on unregistered providerIds. Some event kinds carry no
 * providerId (e.g. ws_reconnect, capability_layer_refresh); in that
 * case the shape is applied without overlay (event kinds with no
 * providerId never break chain by construction).
 */
export function classify(event: ContinuationEvent): ContinuationDecision {
  const shape = SHAPE_BY_KIND[event.kind]
  if (!shape) {
    // exhaustiveness — TypeScript should catch this at compile time
    throw new UnknownContinuationEventError({ kind: event.kind, sessionID: event.sessionID })
  }

  const providerClass = resolveProviderClass(event)

  // SL overlay: chain cannot break; suppress chain-init injection.
  // The amnesia path can still fire on SL (compaction is client-side
  // there regardless), so injectsAmnesia is preserved as-is.
  if (providerClass === "SL") {
    return {
      breaksChain: false,
      capturesDigest: shape.capturesDigest,
      recomputesChainStable: shape.recomputesChainStable,
      injectsChainInit: false,
      injectsAmnesia: shape.injectsAmnesia,
      bumpsRebindEpoch: shape.bumpsRebindEpoch,
      chainBreakClass: shape.ssBreaks ? "SL-noop" : shape.ssBreakClass,
      skipReason: shape.injectsChainInit ? "sl_provider" : shape.skipReason,
    }
  }

  // SS overlay: apply shape verbatim.
  return {
    breaksChain: shape.ssBreaks,
    capturesDigest: shape.capturesDigest,
    recomputesChainStable: shape.recomputesChainStable,
    injectsChainInit: shape.injectsChainInit,
    injectsAmnesia: shape.injectsAmnesia,
    bumpsRebindEpoch: shape.bumpsRebindEpoch,
    chainBreakClass: shape.ssBreaks ? shape.ssBreakClass : shape.ssBreakClass,
    skipReason: shape.injectsChainInit ? undefined : shape.skipReason,
  }
}

/**
 * Resolve provider class for an event. Events without a providerId
 * (capability_layer_refresh, ws_reconnect, session_fork, etc.) fall
 * back to SL because they semantically cannot break a server-side
 * chain — they're client-orchestrated.
 */
function resolveProviderClass(event: ContinuationEvent): ProviderChainClass {
  if (!("providerId" in event) || !event.providerId) {
    return "SL"
  }
  return classifyProvider(event.providerId)
}

// -------------------------------------------------------------------------
// Errors
// -------------------------------------------------------------------------

export const UnknownContinuationEventError = NamedError.create(
  "UnknownContinuationEventError",
  z.object({
    kind: z.string(),
    sessionID: z.string().optional(),
  }),
)
