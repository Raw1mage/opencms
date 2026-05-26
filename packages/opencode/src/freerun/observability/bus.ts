/**
 * harness/freerun-mode — typed Bus event definitions + emit helpers.
 *
 * One entry per row in observability.md's Bus event catalog. Definitions
 * live here so subscribers (warroom, aisecurity sidecar bridge, future
 * dashboards) can `import { FreerunBus } from "..."` and subscribe with
 * static types.
 *
 * Wire-up: iterate.ts, consolidate.ts, workflow-runner adapter call
 * `FreerunBus.emit.<eventName>(...)`. Direct `safe(...)` is also
 * fine — `emit.*` is just a typing convenience.
 */

import z from "zod"
import { Bus } from "../../bus"
import { BusEvent } from "../../bus/bus-event"
import type { TriggerMode, ExperimentConfig, NodeMode, FreerunFinalStatus } from "../types"

export namespace FreerunBus {
  // ============================================================================
  // Common payload primitives
  // ============================================================================

  const at = z.string() // ISO timestamp
  const sessionID = z.string()
  const iteration = z.number().int().min(0)
  const nodeID = z.string()
  const nodeMode: z.ZodType<NodeMode> = z.enum([
    "pending-plan",
    "pending-exec",
    "doing",
    "decomposed",
    "done",
    "blocked",
  ])

  // ============================================================================
  // Lifecycle events
  // ============================================================================

  export const SessionStarted = BusEvent.define(
    "freerun.session.started",
    z.object({
      sessionID,
      triggerMode: z.enum(["cron", "watchdog", "goal"]) satisfies z.ZodType<TriggerMode>,
      providerID: z.string(),
      userID: z.string(),
      rootNodeID: nodeID,
      experimentConfigID: z.string(),
      protocolVersion: z.literal("v0"),
      at,
    }),
  )

  export const SessionPaused = BusEvent.define(
    "freerun.session.paused",
    z.object({ sessionID, atIteration: iteration, by: z.string(), at }),
  )

  export const SessionResumed = BusEvent.define(
    "freerun.session.resumed",
    z.object({ sessionID, atIteration: iteration, at }),
  )

  export const SessionTerminated = BusEvent.define(
    "freerun.session.terminated",
    z.object({
      sessionID,
      finalStatus: z.enum([
        "in_progress",
        "done",
        "blocked",
        "cap_reached",
        "paused",
        "user_interrupted",
        "error",
      ]) satisfies z.ZodType<FreerunFinalStatus>,
      totalIterations: z.number().int().min(0),
      pathMetricsSummary: z.unknown().optional(),
      at,
    }),
  )

  export const SessionRefused = BusEvent.define(
    "freerun.session.refused",
    z.object({ sessionID, providerID: z.string(), reason: z.string(), at }),
  )

  // ============================================================================
  // Iteration events
  // ============================================================================

  export const IterationStart = BusEvent.define(
    "freerun.iteration.start",
    z.object({
      sessionID,
      iteration,
      nodeID,
      nodeMode,
      depth: z.number().int().min(0),
      pickedByPolicyReason: z.string(),
      at,
    }),
  )

  export const IterationWorkingSetAssembled = BusEvent.define(
    "freerun.iteration.workingSetAssembled",
    z.object({
      sessionID,
      iteration,
      navBandTokens: z.number().int().min(0),
      currentDetailTokens: z.number().int().min(0),
      totalTokens: z.number().int().min(0),
      sectionsPresent: z.array(z.string()),
      at,
    }),
  )

  export const IterationPromptBuilt = BusEvent.define(
    "freerun.iteration.promptBuilt",
    z.object({
      sessionID,
      iteration,
      schemaName: z.string(),
      schemaSizeBytes: z.number().int().min(0),
      messagesLength: z.number().int().min(0),
      at,
    }),
  )

  export const IterationCompleted = BusEvent.define(
    "freerun.iteration.completed",
    z.object({
      sessionID,
      iteration,
      nodeID,
      latencyMs: z.number().int().min(0),
      tokensIn: z.number().int().min(0).optional(),
      tokensOut: z.number().int().min(0).optional(),
      finishReason: z.string().optional(),
      validationResult: z.enum(["ok", "retry-succeeded", "blocked"]),
      at,
    }),
  )

  export const IterationHalted = BusEvent.define(
    "freerun.iteration.halted",
    z.object({
      sessionID,
      iteration,
      nodeID: nodeID.optional(),
      reason: z.string(),
      errors: z.array(z.string()).default([]),
      at,
    }),
  )

  // ============================================================================
  // LLM events
  // ============================================================================

  export const LlmRequestSent = BusEvent.define(
    "freerun.llm.requestSent",
    z.object({
      sessionID,
      iteration,
      nodeID,
      nodeMode,
      modelID: z.string(),
      requestBodyHash: z.string(),
      headersHash: z.string(),
      at,
    }),
  )

  export const LlmResponseReceived = BusEvent.define(
    "freerun.llm.responseReceived",
    z.object({
      sessionID,
      iteration,
      latencyMs: z.number().int().min(0),
      tokensIn: z.number().int().min(0).optional(),
      tokensOut: z.number().int().min(0).optional(),
      schemaValidationResult: z.enum(["ok", "fail", "skipped"]),
      finishReason: z.string().optional(),
      at,
    }),
  )

  export const LlmValidationRetry = BusEvent.define(
    "freerun.llm.validationRetry",
    z.object({
      sessionID,
      iteration,
      attemptNumber: z.number().int().min(1),
      validationErrors: z.array(z.string()),
      at,
    }),
  )

  // ============================================================================
  // Cognitive events
  // ============================================================================

  export const DecisionEmitted = BusEvent.define(
    "freerun.decision.emitted",
    z.object({
      sessionID,
      iteration,
      nodeID,
      decisionID: z.string(),
      decisionText: z.string(),
      rationale: z.string(),
      at,
    }),
  )

  export const ChildrenPlanned = BusEvent.define(
    "freerun.children.planned",
    z.object({
      sessionID,
      iteration,
      parentNodeID: nodeID,
      childIDs: z.array(z.string()),
      childTitles: z.array(z.string()),
      at,
    }),
  )

  export const ObservationRecorded = BusEvent.define(
    "freerun.observation.recorded",
    z.object({
      sessionID,
      iteration,
      nodeID,
      observationText: z.string(),
      at,
    }),
  )

  // ============================================================================
  // Tool events
  // ============================================================================

  export const ToolInvoked = BusEvent.define(
    "freerun.tool.invoked",
    z.object({ sessionID, iteration, nodeID, toolName: z.string(), args: z.unknown(), at }),
  )

  export const ToolCompleted = BusEvent.define(
    "freerun.tool.completed",
    z.object({
      sessionID,
      iteration,
      nodeID,
      toolName: z.string(),
      latencyMs: z.number().int().min(0),
      success: z.boolean(),
      resultExcerpt: z.string().optional(),
      at,
    }),
  )

  // ============================================================================
  // Skill events
  // ============================================================================

  export const SkillTriggered = BusEvent.define(
    "freerun.skill.triggered",
    z.object({
      sessionID,
      iteration,
      nodeID,
      skillName: z.string(),
      triggerPatternMatch: z.string(),
      usedInIteration: z.boolean(),
      at,
    }),
  )

  // ============================================================================
  // State events
  // ============================================================================

  export const NodeStateTransition = BusEvent.define(
    "freerun.node.stateTransition",
    z.object({
      sessionID,
      iteration,
      nodeID,
      fromMode: nodeMode,
      toMode: nodeMode,
      reason: z.string(),
      at,
    }),
  )

  // ============================================================================
  // Blocker events
  // ============================================================================

  export const BlockerRaised = BusEvent.define(
    "freerun.blocker.raised",
    z.object({
      sessionID,
      iteration,
      nodeID,
      blockerText: z.string(),
      severity: z.enum(["soft", "hard"]),
      firstSeen: at,
      at,
    }),
  )

  export const BlockerResolved = BusEvent.define(
    "freerun.blocker.resolved",
    z.object({
      sessionID,
      iteration,
      nodeID,
      blockerText: z.string(),
      resolvedByNodeID: nodeID,
      resolutionAction: z.string(),
      at,
    }),
  )

  // ============================================================================
  // Adaptation events
  // ============================================================================

  export const ReplanTriggered = BusEvent.define(
    "freerun.replan.triggered",
    z.object({
      sessionID,
      iteration,
      nodeID,
      triggerReason: z.string(),
      invalidatedAssumptions: z.array(z.string()),
      at,
    }),
  )

  export const ConsolidationPerformed = BusEvent.define(
    "freerun.consolidation.performed",
    z.object({
      sessionID,
      iteration: iteration.optional(),
      parentNodeID: nodeID,
      childrenArchived: z.array(z.string()),
      summaryTokens: z.number().int().min(0),
      archivePath: z.string(),
      at,
    }),
  )

  // ============================================================================
  // emit.* convenience surface (typed wrappers around Bus.publish)
  // ============================================================================

  function nowIso(): string {
    return new Date().toISOString()
  }

  /**
   * Publish wrapper that swallows context-resolution errors.
   * Lets iterate.ts / consolidate.ts emit unconditionally; outside
   * an Instance context (unit tests) the emit is a no-op.
   */
  async function safe<D extends Parameters<typeof Bus.publish>[0]>(def: D, props: any): Promise<void> {
    try {
      await Bus.publish(def, props)
    } catch {
      // no Instance context (tests, or pre-init); drop silently
    }
  }

  /** Awaitable emit helpers. Each takes the payload sans `at` (auto-stamped). */
  export const emit = {
    sessionStarted: (p: Omit<z.infer<typeof SessionStarted.properties>, "at">) =>
      safe(SessionStarted, { ...p, at: nowIso() }),
    sessionPaused: (p: Omit<z.infer<typeof SessionPaused.properties>, "at">) =>
      safe(SessionPaused, { ...p, at: nowIso() }),
    sessionResumed: (p: Omit<z.infer<typeof SessionResumed.properties>, "at">) =>
      safe(SessionResumed, { ...p, at: nowIso() }),
    sessionTerminated: (p: Omit<z.infer<typeof SessionTerminated.properties>, "at">) =>
      safe(SessionTerminated, { ...p, at: nowIso() }),
    sessionRefused: (p: Omit<z.infer<typeof SessionRefused.properties>, "at">) =>
      safe(SessionRefused, { ...p, at: nowIso() }),
    iterationStart: (p: Omit<z.infer<typeof IterationStart.properties>, "at">) =>
      safe(IterationStart, { ...p, at: nowIso() }),
    iterationWorkingSetAssembled: (p: Omit<z.infer<typeof IterationWorkingSetAssembled.properties>, "at">) =>
      safe(IterationWorkingSetAssembled, { ...p, at: nowIso() }),
    iterationPromptBuilt: (p: Omit<z.infer<typeof IterationPromptBuilt.properties>, "at">) =>
      safe(IterationPromptBuilt, { ...p, at: nowIso() }),
    iterationCompleted: (p: Omit<z.infer<typeof IterationCompleted.properties>, "at">) =>
      safe(IterationCompleted, { ...p, at: nowIso() }),
    iterationHalted: (p: Omit<z.infer<typeof IterationHalted.properties>, "at">) =>
      safe(IterationHalted, { ...p, at: nowIso() }),
    llmRequestSent: (p: Omit<z.infer<typeof LlmRequestSent.properties>, "at">) =>
      safe(LlmRequestSent, { ...p, at: nowIso() }),
    llmResponseReceived: (p: Omit<z.infer<typeof LlmResponseReceived.properties>, "at">) =>
      safe(LlmResponseReceived, { ...p, at: nowIso() }),
    llmValidationRetry: (p: Omit<z.infer<typeof LlmValidationRetry.properties>, "at">) =>
      safe(LlmValidationRetry, { ...p, at: nowIso() }),
    decisionEmitted: (p: Omit<z.infer<typeof DecisionEmitted.properties>, "at">) =>
      safe(DecisionEmitted, { ...p, at: nowIso() }),
    childrenPlanned: (p: Omit<z.infer<typeof ChildrenPlanned.properties>, "at">) =>
      safe(ChildrenPlanned, { ...p, at: nowIso() }),
    observationRecorded: (p: Omit<z.infer<typeof ObservationRecorded.properties>, "at">) =>
      safe(ObservationRecorded, { ...p, at: nowIso() }),
    toolInvoked: (p: Omit<z.infer<typeof ToolInvoked.properties>, "at">) =>
      safe(ToolInvoked, { ...p, at: nowIso() }),
    toolCompleted: (p: Omit<z.infer<typeof ToolCompleted.properties>, "at">) =>
      safe(ToolCompleted, { ...p, at: nowIso() }),
    skillTriggered: (p: Omit<z.infer<typeof SkillTriggered.properties>, "at">) =>
      safe(SkillTriggered, { ...p, at: nowIso() }),
    nodeStateTransition: (p: Omit<z.infer<typeof NodeStateTransition.properties>, "at">) =>
      safe(NodeStateTransition, { ...p, at: nowIso() }),
    blockerRaised: (p: Omit<z.infer<typeof BlockerRaised.properties>, "at" | "firstSeen"> & { firstSeen?: string }) => {
      const now = nowIso()
      return safe(BlockerRaised, { ...p, firstSeen: p.firstSeen ?? now, at: now })
    },
    blockerResolved: (p: Omit<z.infer<typeof BlockerResolved.properties>, "at">) =>
      safe(BlockerResolved, { ...p, at: nowIso() }),
    replanTriggered: (p: Omit<z.infer<typeof ReplanTriggered.properties>, "at">) =>
      safe(ReplanTriggered, { ...p, at: nowIso() }),
    consolidationPerformed: (p: Omit<z.infer<typeof ConsolidationPerformed.properties>, "at">) =>
      safe(ConsolidationPerformed, { ...p, at: nowIso() }),
  }
}
