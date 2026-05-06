/**
 * Empty-turn cause-family classifier for the codex provider.
 *
 * Pure function (INV-12, design.md DD-1): no I/O, no global state beyond
 * the immutable enum constants, identical output for identical input.
 * Side effects (log emission, retry dispatch, finish-part construction)
 * happen at the call site in sse.ts / transport-ws.ts.
 *
 * Phase 1 stub (design.md DD-12): every input returns
 * {causeFamily: "unclassified", recoveryAction: "pass-through-to-runloop-nudge"}.
 * This is intentional — the goal of Phase 1 is to ship the LOG path
 * (D-2 evidence floor) and start collecting production data. Phase 2
 * will replace this stub with real cause-family predicates per DD-9.
 *
 * spec.md Requirements: cause-family classification, recovery-action
 * vocabulary, audit-before-omit (suspectParams).
 * data-schema.json: causeFamily + recoveryAction enum source of truth.
 * INV-13: causeFamily enum is append-only.
 * INV-14: recoveryAction enum is closed; hard-error excluded permanently.
 */

// ---------------------------------------------------------------------------
// § 1  Enum constants (single source of truth; mirrors data-schema.json)
// ---------------------------------------------------------------------------

/**
 * Cause family enum. Append-only per INV-13.
 *
 * Phase 1 stub selects "unclassified" for every empty turn.
 * Phase 2 (DD-12) wires real predicates that may select any of the six.
 */
export const CAUSE_FAMILY = {
  WS_TRUNCATION: "ws_truncation",
  WS_NO_FRAMES: "ws_no_frames",
  SERVER_EMPTY_OUTPUT_WITH_REASONING: "server_empty_output_with_reasoning",
  SERVER_INCOMPLETE: "server_incomplete",
  SERVER_FAILED: "server_failed",
  UNCLASSIFIED: "unclassified",
} as const

export type CauseFamily = (typeof CAUSE_FAMILY)[keyof typeof CAUSE_FAMILY]

/**
 * Recovery action enum. Closed per INV-14. `hard-error` is permanently
 * excluded by Decision D-1 and can never be added.
 */
export const RECOVERY_ACTION = {
  RETRY_ONCE_THEN_SOFT_FAIL: "retry-once-then-soft-fail",
  SYNTHESIZE_FROM_DELTAS: "synthesize-from-deltas",
  PASS_THROUGH_TO_RUNLOOP_NUDGE: "pass-through-to-runloop-nudge",
  LOG_AND_CONTINUE: "log-and-continue",
} as const

export type RecoveryAction = (typeof RECOVERY_ACTION)[keyof typeof RECOVERY_ACTION]

/**
 * Suspect parameter names — the subset we audit per Decision D-3.
 * Used by Phase 2 server_empty_output_with_reasoning predicate.
 */
export type SuspectParam =
  | "reasoning.effort"
  | "include.reasoning.encrypted_content"
  | "prompt_cache_retention"
  | "store"

// ---------------------------------------------------------------------------
// § 2  Input snapshot shape (caller assembles, classifier reads)
// ---------------------------------------------------------------------------

/**
 * Sanitized request body shape — what the classifier examines for cause B/C
 * predicate. Caller is responsible for sanitization (no PII, no tokens).
 */
export interface RequestOptionsShape {
  store: boolean
  hasReasoningEffort: boolean
  reasoningEffortValue: string | null
  includeFields: string[]
  hasTools: boolean
  toolCount: number
  promptCacheKeyHash: string
  inputItemCount: number
  instructionsByteSize: number
}

/**
 * Counts of delta events observed during the stream. Empty-turn means
 * text and toolCallArguments are both 0 (INV-10).
 */
export interface DeltasObserved {
  text: number
  toolCallArguments: number
  reasoning: number
}

/**
 * Snapshot the classifier consumes. Assembled by the call site from
 * stream + WS state + request body.
 */
export interface EmptyTurnSnapshot {
  /** WS frames received (>0 means stream started; 0 means ws lost early) */
  wsFrameCount: number
  /** True iff one of the four terminal SSE events arrived */
  terminalEventReceived: boolean
  /** Which terminal event landed; null if none */
  terminalEventType:
    | "response.completed"
    | "response.incomplete"
    | "response.failed"
    | "error"
    | null
  /** WS close code if available (from ws.onclose), null if event was onerror */
  wsCloseCode: number | null
  /** WS close reason string if available; truncated by caller to 256 chars */
  wsCloseReason: string | null
  /** Verbatim server error message (server_failed / server_incomplete only) */
  serverErrorMessage: string | null
  /** Counts by delta type observed during the stream */
  deltasObserved: DeltasObserved
  /** Sanitized request body shape */
  requestOptionsShape: RequestOptionsShape
  /** True iff this snapshot is for a retry attempt (the second one) */
  retryAttempted: boolean
}

// ---------------------------------------------------------------------------
// § 3  Output shape (DD-11; mirrors providerMetadata.openai.emptyTurnClassification)
// ---------------------------------------------------------------------------

export interface ClassificationResult {
  causeFamily: CauseFamily
  recoveryAction: RecoveryAction
  /** Subset of param names flagged as suspect for this cause family */
  suspectParams: SuspectParam[]
}

// ---------------------------------------------------------------------------
// § 4  Classifier (Phase 1 stub)
// ---------------------------------------------------------------------------

/**
 * Phase 1 stub: every input → unclassified + pass-through.
 *
 * INV-12 (purity): no I/O, no global state, deterministic.
 * INV-04 (always log): caller must invoke appendEmptyTurnLog regardless
 * of the result returned here.
 *
 * Phase 2 (DD-12) replaces this stub with the predicate ladder per DD-9.
 * The Phase 2 implementation MUST preserve the shape of this return type
 * and MUST NOT add any side effects to this function.
 */
export function classifyEmptyTurn(_snapshot: EmptyTurnSnapshot): ClassificationResult {
  return {
    causeFamily: CAUSE_FAMILY.UNCLASSIFIED,
    recoveryAction: RECOVERY_ACTION.PASS_THROUGH_TO_RUNLOOP_NUDGE,
    suspectParams: [],
  }
}

// ---------------------------------------------------------------------------
// § 5  Log payload assembly (helper; caller adds context fields)
// ---------------------------------------------------------------------------

/**
 * Fields the classifier + snapshot can produce by themselves. The caller
 * adds session-context fields (sessionId, messageId, accountId, providerId,
 * modelId, timestamp, logSequence) to form a full log entry conforming
 * to data-schema.json schemaVersion 1.
 */
export interface ClassificationLogPayload extends ClassificationResult {
  schemaVersion: 1
  wsFrameCount: number
  terminalEventReceived: boolean
  terminalEventType: EmptyTurnSnapshot["terminalEventType"]
  wsCloseCode: number | null
  wsCloseReason: string | null
  serverErrorMessage: string | null
  deltasObserved: DeltasObserved
  requestOptionsShape: RequestOptionsShape
  retryAttempted: boolean
  retryAlsoEmpty: boolean | null
  previousLogSequence: number | null
}

/**
 * Build the classifier-derived portion of a log entry. The caller
 * combines the result with timestamp, logSequence, sessionId, messageId,
 * accountId, providerId, modelId, streamStateSnapshot to form a full
 * log entry (data-schema.json schemaVersion 1).
 */
export function buildClassificationPayload(
  snapshot: EmptyTurnSnapshot,
  classification: ClassificationResult,
  retryContext: { retryAlsoEmpty: boolean | null; previousLogSequence: number | null } = {
    retryAlsoEmpty: null,
    previousLogSequence: null,
  },
): ClassificationLogPayload {
  return {
    schemaVersion: 1,
    causeFamily: classification.causeFamily,
    recoveryAction: classification.recoveryAction,
    suspectParams: classification.suspectParams,
    wsFrameCount: snapshot.wsFrameCount,
    terminalEventReceived: snapshot.terminalEventReceived,
    terminalEventType: snapshot.terminalEventType,
    wsCloseCode: snapshot.wsCloseCode,
    wsCloseReason: snapshot.wsCloseReason,
    serverErrorMessage: snapshot.serverErrorMessage,
    deltasObserved: snapshot.deltasObserved,
    requestOptionsShape: snapshot.requestOptionsShape,
    retryAttempted: snapshot.retryAttempted,
    retryAlsoEmpty: retryContext.retryAlsoEmpty,
    previousLogSequence: retryContext.previousLogSequence,
  }
}
