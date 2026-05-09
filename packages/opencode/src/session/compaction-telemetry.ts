import { debugCheckpoint } from "@/util/debug"
import type { SessionCompaction } from "./compaction"

type BoundaryKind = "user_attachment" | "subagent_result" | "attachment_query"
type BoundaryAction = "inline" | "attachment_ref" | "digest" | "capability_error" | "missing_ref"

function finiteNumber(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function boundedString(value: string | undefined): string | undefined {
  if (!value) return undefined
  return value
    .replace(/(authorization\s*[:=]\s*)(bearer\s+)?[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/(api[_-]?key\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/(token\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/(secret\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .slice(0, 240)
}

export function buildCompactionPredicateTelemetry(input: {
  sessionID: string
  step?: number
  outcome: "fire" | "block" | "none"
  reason: string
  observed?: SessionCompaction.Observed | null
  currentInputTokens?: number
  modelContextWindow?: number
  predictedCacheMiss?: "miss" | "hit" | "unknown"
  hasLastFinished?: boolean
  hasCompactionRequest?: boolean
  isSubagent?: boolean
}) {
  const window = finiteNumber(input.modelContextWindow)
  const currentInputTokens = finiteNumber(input.currentInputTokens)
  return {
    surface: "compaction_predicate",
    sessionID: input.sessionID,
    step: input.step,
    outcome: input.outcome,
    reason: boundedString(input.reason),
    observed: input.observed ?? null,
    currentInputTokens,
    modelContextWindow: window,
    ctxRatio: window && currentInputTokens !== undefined ? currentInputTokens / window : undefined,
    predictedCacheMiss: input.predictedCacheMiss,
    hasLastFinished: input.hasLastFinished === true,
    hasCompactionRequest: input.hasCompactionRequest === true,
    isSubagent: input.isSubagent === true,
  }
}

export function buildKindChainTelemetry(input: {
  observed: SessionCompaction.Observed
  providerId?: string
  isSubscription?: boolean
  ctxRatio?: number
  codexServerPriorityRatio?: number
  chain: ReadonlyArray<SessionCompaction.KindName>
}) {
  return {
    surface: "compaction_kind_chain",
    observed: input.observed,
    providerId: boundedString(input.providerId),
    isSubscription: input.isSubscription === true,
    ctxRatio: finiteNumber(input.ctxRatio),
    codexServerPriorityRatio: finiteNumber(input.codexServerPriorityRatio),
    chain: [...input.chain],
  }
}

export function buildContextBudgetTelemetry(input: {
  emitted: boolean
  reason?: string
  window?: number
  used?: number
  ratio?: number
  status?: string
  cacheRead?: number
  cacheHitRate?: number
}) {
  return {
    surface: "context_budget",
    emitted: input.emitted,
    reason: boundedString(input.reason),
    window: finiteNumber(input.window),
    used: finiteNumber(input.used),
    ratio: finiteNumber(input.ratio),
    status: input.status,
    cacheRead: finiteNumber(input.cacheRead),
    cacheHitRate: finiteNumber(input.cacheHitRate),
  }
}

export function buildBoundaryRoutingTelemetry(input: {
  boundary: BoundaryKind
  action: BoundaryAction
  refID?: string
  mime?: string
  byteSize?: number
  estTokens?: number
  thresholdBytes?: number
  previewBytes?: number
  truncated?: boolean
  hasFilename?: boolean
  reason?: string
}) {
  return {
    surface: "big_content_boundary",
    boundary: input.boundary,
    action: input.action,
    refID: boundedString(input.refID),
    mime: boundedString(input.mime),
    byteSize: finiteNumber(input.byteSize),
    estTokens: finiteNumber(input.estTokens),
    thresholdBytes: finiteNumber(input.thresholdBytes),
    previewBytes: finiteNumber(input.previewBytes),
    truncated: input.truncated === true,
    hasFilename: input.hasFilename === true,
    reason: boundedString(input.reason),
  }
}

export function emitCompactionPredicateTelemetry(input: Parameters<typeof buildCompactionPredicateTelemetry>[0]) {
  debugCheckpoint("compaction.telemetry", "predicate", buildCompactionPredicateTelemetry(input))
}

export function emitKindChainTelemetry(input: Parameters<typeof buildKindChainTelemetry>[0]) {
  debugCheckpoint("compaction.telemetry", "kind_chain", buildKindChainTelemetry(input))
}

export function emitContextBudgetTelemetry(input: Parameters<typeof buildContextBudgetTelemetry>[0]) {
  debugCheckpoint("compaction.telemetry", "context_budget", buildContextBudgetTelemetry(input))
}

export function emitBoundaryRoutingTelemetry(input: Parameters<typeof buildBoundaryRoutingTelemetry>[0]) {
  debugCheckpoint("compaction.telemetry", "boundary_routing", buildBoundaryRoutingTelemetry(input))
}

type ReplayOutcome =
  | "replayed"
  | "skipped:already-after-anchor"
  | "skipped:no-unanswered"
  | "skipped:flag-off"
  | "error"

export function buildUserMsgReplayTelemetry(input: {
  sessionID: string
  step?: number
  observed: SessionCompaction.Observed
  outcome: ReplayOutcome
  originalUserID?: string
  newUserID?: string
  anchorMessageID?: string
  hadEmptyAssistantChild?: boolean
  partCount?: number
  errorMessage?: string
}) {
  return {
    surface: "user_msg_replay",
    sessionID: input.sessionID,
    step: input.step,
    observed: input.observed,
    outcome: input.outcome,
    originalUserID: boundedString(input.originalUserID),
    newUserID: boundedString(input.newUserID),
    anchorMessageID: boundedString(input.anchorMessageID),
    hadEmptyAssistantChild: input.hadEmptyAssistantChild === true,
    partCount: finiteNumber(input.partCount),
    errorMessage: boundedString(input.errorMessage),
  }
}

export function emitUserMsgReplayTelemetry(input: Parameters<typeof buildUserMsgReplayTelemetry>[0]) {
  debugCheckpoint("compaction.telemetry", "user_msg_replay", buildUserMsgReplayTelemetry(input))
}
