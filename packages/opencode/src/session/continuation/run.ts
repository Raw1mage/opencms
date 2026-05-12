/**
 * Continuation.run — single procedure executor.
 *
 * Replaces the five scattered `invalidateContinuationFamily` call sites
 * with one classifier-driven dispatch. Each chain-affecting event flows
 * through this function; the matrix in continuation-event.ts decides
 * which steps execute.
 *
 * Ordering invariant (DD-8): digest capture is awaited BEFORE chain
 * invalidation. If invalidation completed first, message-store mutation
 * could race the capture and yield an empty digest, which the AI cannot
 * distinguish from "nothing was committed" — exactly the failure mode
 * we're trying to prevent.
 *
 * Each step is best-effort: a failure in one step does NOT abort
 * subsequent steps. Telemetry records the failure so post-hoc audit
 * can find degraded paths.
 */

import { Log } from "../../util/log"
import { RebindEpoch, type RebindTrigger } from "../rebind-epoch"
import { RuntimeEventService } from "../../system/runtime-event-service"
import { captureDigest, type CommitmentDigest } from "./commitment-digest"
import {
  classify,
  type ContinuationDecision,
  type ContinuationEvent,
  type ContinuationEventKind,
} from "./continuation-event"
import { PendingInjectionStore } from "./pending-injection"

const log = Log.create({ service: "continuation.run" })

export interface ContinuationOutcome {
  decision: ContinuationDecision
  digest: CommitmentDigest | null
  /** Whether invalidateContinuationFamily was actually called (and didn't throw). */
  chainInvalidated: boolean
  /** Whether the rebind-epoch bump succeeded (not rate-limited or thrown). */
  epochBumped: boolean
  /** Whether the pending-injection marker was written. */
  pendingMarkWritten: boolean
}

export namespace Continuation {
  /**
   * Run the continuation procedure for an event. Single entry point;
   * every chain-affecting code path SHOULD funnel here in Phase B-C-E
   * rewires. Phase A: this function is callable but no call site yet
   * reaches it — additive only.
   */
  export async function run(event: ContinuationEvent): Promise<ContinuationOutcome> {
    const decision = classify(event)

    log.info("continuation.run dispatched", {
      sessionID: event.sessionID,
      kind: event.kind,
      breaksChain: decision.breaksChain,
      capturesDigest: decision.capturesDigest,
      injectsChainInit: decision.injectsChainInit,
      injectsAmnesia: decision.injectsAmnesia,
      chainBreakClass: decision.chainBreakClass,
    })

    // Step 1: capture digest BEFORE invalidation (DD-8 ordering invariant)
    let digest: CommitmentDigest | null = null
    if (decision.capturesDigest) {
      digest = await captureDigest(event.sessionID).catch((err) => {
        log.warn("captureDigest threw — using sentinel", {
          sessionID: event.sessionID,
          error: err instanceof Error ? err.message : String(err),
        })
        return null
      })
      await emitCommitmentCaptured(event, digest)
    }

    // Step 2: invalidate chain id (no-op for non-codex providers internally)
    let chainInvalidated = false
    if (decision.breaksChain) {
      try {
        const { invalidateContinuationFamily } = await import("@opencode-ai/codex-provider/continuation")
        invalidateContinuationFamily(event.sessionID)
        chainInvalidated = true
        log.info("chain family invalidated", { sessionID: event.sessionID, kind: event.kind })
      } catch (err) {
        log.warn("invalidateContinuationFamily threw — continuing", {
          sessionID: event.sessionID,
          error: err instanceof Error ? err.message : String(err),
        })
        await emitInvalidateFailed(event, err)
      }
    }

    // Step 3: mark pending injection (consumed by next outbound prompt build)
    let pendingMarkWritten = false
    if (decision.injectsChainInit || decision.injectsAmnesia) {
      try {
        PendingInjectionStore.mark(event.sessionID, {
          chainInit: decision.injectsChainInit,
          amnesia: decision.injectsAmnesia,
          digest,
          reason: event.kind,
          anchorId: "anchorId" in event ? event.anchorId : undefined,
          ts: Date.now(),
        })
        pendingMarkWritten = true
      } catch (err) {
        log.warn("PendingInjectionStore.mark threw — degraded but continuing", {
          sessionID: event.sessionID,
          error: err instanceof Error ? err.message : String(err),
        })
        await emitInitPersistFailed(event, err)
      }
    }

    // Step 4: bump rebind epoch (drives chain_stable fragment recompute via SSE)
    let epochBumped = false
    if (decision.bumpsRebindEpoch) {
      try {
        const outcome = await RebindEpoch.bumpEpoch({
          sessionID: event.sessionID,
          trigger: mapToRebindTrigger(event.kind),
          reason: continuationReasonString(event),
          // Phase D: thread the classifier through so the
          // session.rebind event payload carries chainBreakClass
          // alongside trigger / epoch counters.
          chainBreakClass: decision.chainBreakClass,
        })
        epochBumped = outcome.status === "bumped"
      } catch (err) {
        log.warn("RebindEpoch.bumpEpoch threw — continuing", {
          sessionID: event.sessionID,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    // Step 5: emit injected/skipped telemetry
    await emitInjectedOrSkipped(event, decision, digest)

    return { decision, digest, chainInvalidated, epochBumped, pendingMarkWritten }
  }
}

// -------------------------------------------------------------------------
// RebindTrigger mapping
// -------------------------------------------------------------------------

/**
 * Map ContinuationEventKind onto the existing RebindEpoch.RebindTrigger
 * enum. The trigger enum predates this plan and is used by other
 * telemetry consumers; we map rather than extend so old consumers keep
 * working. The chainBreakClass payload field carries the precise event
 * kind for new consumers.
 */
function mapToRebindTrigger(kind: ContinuationEventKind): RebindTrigger {
  switch (kind) {
    case "account_switch":
    case "account_rotate":
    case "provider_switch":
    case "model_switch_same_family":
    case "model_switch_cross_family":
    case "backend_failure_forced_resend":
      return "provider_switch"
    case "session_fork":
    case "session_resume_daemon_alive":
    case "session_resume_after_daemon_restart":
      return "session_resume"
    case "capability_layer_refresh":
    case "user_clear":
      return "slash_reload"
    case "compaction_narrative":
    case "compaction_cache_aware":
    case "compaction_stall_recovery":
    case "compaction_preemptive_daemon_restart":
    case "compaction_server_side":
    case "empty_response_recovery":
    case "ws_reconnect":
    case "subagent_spawn":
      return "tool_call"
    default:
      return "tool_call"
  }
}

function continuationReasonString(event: ContinuationEvent): string {
  switch (event.kind) {
    case "account_switch":
    case "account_rotate":
      return `account ${event.previousAccountId} → ${event.accountId}`
    case "provider_switch":
      return `provider ${event.previousProviderId} → ${event.providerId}`
    case "model_switch_same_family":
    case "model_switch_cross_family":
      return `model ${event.previousModelId} → ${event.modelId}`
    case "capability_layer_refresh":
      return event.reason
    case "compaction_narrative":
    case "compaction_cache_aware":
    case "compaction_stall_recovery":
    case "compaction_preemptive_daemon_restart":
    case "compaction_server_side":
      return `compaction anchor=${event.anchorId}`
    case "empty_response_recovery":
      return `emptyRoundCount=${event.emptyRoundCount}`
    case "backend_failure_forced_resend":
      return `classifier=${event.classifier}`
    default:
      return event.kind
  }
}

// -------------------------------------------------------------------------
// Telemetry emitters
// -------------------------------------------------------------------------

async function emitCommitmentCaptured(
  event: ContinuationEvent,
  digest: CommitmentDigest | null,
): Promise<void> {
  try {
    await RuntimeEventService.append({
      level: "info",
      domain: "telemetry",
      eventType: digest === null ? "chain.commitment.failed" : "chain.commitment.captured",
      sessionID: event.sessionID,
      anomalyFlags: [],
      payload: digest
        ? {
            sourceMessageCount: digest.sourceMessageCount,
            digestEntryCount: digest.entries.length,
            capturedAt: digest.capturedAt,
            eventKind: event.kind,
          }
        : { eventKind: event.kind },
    })
  } catch (err) {
    log.warn("emitCommitmentCaptured failed", {
      sessionID: event.sessionID,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

async function emitInvalidateFailed(event: ContinuationEvent, err: unknown): Promise<void> {
  try {
    await RuntimeEventService.append({
      level: "warn",
      domain: "workflow",
      eventType: "chain.invalidate.failed",
      sessionID: event.sessionID,
      anomalyFlags: [],
      payload: {
        eventKind: event.kind,
        error: err instanceof Error ? err.message : String(err),
      },
    })
  } catch {
    // already in a degraded path
  }
}

async function emitInitPersistFailed(event: ContinuationEvent, err: unknown): Promise<void> {
  try {
    await RuntimeEventService.append({
      level: "warn",
      domain: "workflow",
      eventType: "chain.init.persist.failed",
      sessionID: event.sessionID,
      anomalyFlags: [],
      payload: {
        eventKind: event.kind,
        error: err instanceof Error ? err.message : String(err),
      },
    })
  } catch {
    // swallow
  }
}

async function emitInjectedOrSkipped(
  event: ContinuationEvent,
  decision: ContinuationDecision,
  digest: CommitmentDigest | null,
): Promise<void> {
  try {
    if (decision.injectsChainInit) {
      const bodyCharCount = digest?.bodyCharCount ?? 0
      await RuntimeEventService.append({
        level: "info",
        domain: "workflow",
        eventType: "chain.init.injected",
        sessionID: event.sessionID,
        anomalyFlags: [],
        payload: {
          eventKind: event.kind,
          digestEntryCount: digest?.entries.length ?? 0,
          bodyCharCount,
          reason: event.kind,
          chainBreakClass: decision.chainBreakClass,
        },
      })
    } else {
      await RuntimeEventService.append({
        level: "info",
        domain: "workflow",
        eventType: "chain.init.skipped",
        sessionID: event.sessionID,
        anomalyFlags: [],
        payload: {
          eventKind: event.kind,
          reason: decision.skipReason ?? "unspecified",
          chainBreakClass: decision.chainBreakClass,
        },
      })
    }
  } catch (err) {
    log.warn("emitInjectedOrSkipped failed", {
      sessionID: event.sessionID,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
