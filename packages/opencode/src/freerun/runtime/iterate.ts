/**
 * harness/freerun-mode — single iteration primitive (DD-3d).
 *
 * One iteration:
 *   1. Pick next node from the tree (PickNext, DD-3b)
 *   2. Render context (navigation band + node detail)
 *   3. Build mode-specific prompt (PromptTemplate)
 *   4. Call LLM via injected LlmClient
 *      - planning  → server-enforced json_schema (no tools)
 *      - execution → tools enabled (Claude-style), client-side Zod check + 1 retry
 *   5. Write outcome back to the per-node markdown file
 *   6. Return discriminated result so the caller (engine loop) can branch
 *
 * This module owns NO HTTP. The LlmClient interface is the only seam
 * between freerun engine logic and provider-specific transport. Tests
 * use a stub LlmClient; the workflow-runner adapter (Phase 1.16-1.19)
 * supplies a real one wired to opencode's provider stack.
 */

import { Tree } from "../storage/tree"
import { NodeFS } from "../storage/node-fs"
import { NavigationBand } from "../render/navigation-band"
import { NodeDetail } from "../render/node-detail"
import { PromptTemplate } from "../render/prompt-template"
import { ToolFilter } from "../render/tool-filter"
import { PickNext } from "../policy/pick-next"
import { FreerunBus } from "../observability/bus"
import {
  ContextNode,
  ExecutionOutcome,
  PlanningOutcome,
  type ExperimentConfig,
  type NodeMode,
} from "../types"

export namespace Iterate {
  // ============================================================================
  // LlmClient seam
  // ============================================================================

  export interface PlanningRequest {
    systemPrompt: string
    userMessage: string
    responseSchema: unknown
    responseSchemaName: string
    temperature: number
  }

  export interface ExecutionRequest {
    systemPrompt: string
    userMessage: string
    tools: ToolFilter.ToolRecord[]
    /** Hint to the client: false when tools were suppressed (node.relevant_tools=[]). */
    toolsSuppressed: boolean
    temperature: number
  }

  export interface ExecutionRawResult {
    /** Final assistant message text (after the agent's tool-call loop). */
    finalContent: string
    /** Optional: how many tool calls were dispatched during this execution call. */
    toolCallCount: number
  }

  export interface LlmClient {
    /** Planning mode — server-enforced schema, no tools. */
    callPlanning(req: PlanningRequest): Promise<PlanningOutcome>
    /**
     * Execution mode — Claude-style: tools enabled, agent loop runs to final content.
     * Returns the raw final assistant content; iterate.ts is responsible for
     * Zod-parsing it into an ExecutionOutcome (with one retry on failure).
     */
    callExecution(req: ExecutionRequest): Promise<ExecutionRawResult>
  }

  // ============================================================================
  // Public API
  // ============================================================================

  export interface IterateOptions {
    sessionId: string
    dataHome: string
    config: ExperimentConfig
    llm: LlmClient
    /** Full tool catalog for this session — iterate.ts filters per-node via ToolFilter. */
    toolCatalog: ToolFilter.ToolRecord[]
    /** Iteration counter for this session — used for Bus event correlation. Defaults to 0. */
    iteration?: number
    /** Wall-clock now() in ISO format — injectable for deterministic tests. */
    nowIso?: () => string
    /** Project conventions (AGENTS.md) — passed through to PromptTemplate. */
    agentsMdContent?: string
    /** Operational rules (SYSTEM.md) — passed through to PromptTemplate. */
    systemMdContent?: string
  }

  export type IterateResult =
    | { kind: "advanced"; nodeId: string; mode: "planning" | "execution" }
    | { kind: "settled" }
    | { kind: "blocked"; nodeId: string; reason: string }

  /** Run exactly one iteration. Returns the result; does not loop. */
  export async function once(opts: IterateOptions): Promise<IterateResult> {
    const now = opts.nowIso ?? defaultNowIso
    const iteration = opts.iteration ?? 0
    const tree = await Tree.load(opts.sessionId, opts.dataHome)
    const pick = PickNext.pick(tree, opts.config)
    if (pick.kind === "settled") return { kind: "settled" }
    const node = pick.node

    await FreerunBus.emit.iterationStart({
      sessionID: opts.sessionId,
      iteration,
      nodeID: node.id,
      nodeMode: node.mode,
      depth: Tree.depthOf(tree, node.id),
      pickedByPolicyReason: node.mode === "pending-plan" ? "phaseA-pending-plan" : "phaseB-actionable",
    })

    // Step 1: render context
    const navBand = NavigationBand.render(tree, node.id, {
      policy: opts.config.nav_band_policy,
      tokenBudget: opts.config.nav_band_token_budget,
    })
    const detail = NodeDetail.render(node)

    const sectionsPresent: string[] = []
    if (navBand.text.length > 0) sectionsPresent.push("nav-band")
    sectionsPresent.push("node-detail")

    await FreerunBus.emit.iterationWorkingSetAssembled({
      sessionID: opts.sessionId,
      iteration,
      navBandTokens: navBand.approxTokens,
      currentDetailTokens: Math.ceil(detail.text.length / 4),
      totalTokens: navBand.approxTokens + Math.ceil(detail.text.length / 4),
      sectionsPresent,
    })

    // Step 2-4: mode dispatch
    if (node.mode === "pending-plan") {
      return runPlanning(opts, node, navBand.text, detail.text, now, iteration)
    }
    // pending-exec / doing → execution path
    return runExecution(opts, node, navBand.text, detail.text, now, iteration)
  }

  // ============================================================================
  // Planning path
  // ============================================================================

  async function runPlanning(
    opts: IterateOptions,
    node: ContextNode,
    navBandText: string,
    detailText: string,
    now: () => string,
    iteration: number,
  ): Promise<IterateResult> {
    const tpl = PromptTemplate.render({
      navBandText,
      nodeDetailText: detailText,
      mode: "planning",
      strictness: opts.config.prompt_strictness,
      agentsMdContent: opts.agentsMdContent,
      systemMdContent: opts.systemMdContent,
    })

    await FreerunBus.emit.iterationPromptBuilt({
      sessionID: opts.sessionId,
      iteration,
      schemaName: tpl.responseSchemaName,
      schemaSizeBytes: JSON.stringify(tpl.responseSchema).length,
      messagesLength: 2, // system + user
    })

    const req: PlanningRequest = {
      systemPrompt: tpl.systemPrompt,
      userMessage: tpl.userMessage,
      responseSchema: tpl.responseSchema,
      responseSchemaName: tpl.responseSchemaName,
      temperature: opts.config.mode_dispatch_temperature_plan,
    }
    let outcome: PlanningOutcome
    const t0 = Date.now()
    try {
      const raw = await opts.llm.callPlanning(req)
      outcome = PlanningOutcome.parse(raw) // belt-and-suspenders even though server enforced schema
    } catch (err) {
      const reason = `planning LLM call failed: ${formatError(err)}`
      await FreerunBus.emit.iterationHalted({
        sessionID: opts.sessionId,
        iteration,
        nodeID: node.id,
        reason,
        errors: [formatError(err)],
      })
      return blockNode(opts, node, now, reason, iteration)
    }

    // Persist children
    const updatedAt = now()
    const newChildIds: string[] = []
    const childTitles: string[] = []
    for (const child of outcome.children) {
      const id = ensureNamespacedChildId(node.id, child.id)
      newChildIds.push(id)
      childTitles.push(child.title)
      const childNode: ContextNode = {
        id,
        parent_id: node.id,
        children_ids: [],
        title: child.title,
        body: child.body,
        mode: child.mode ?? "pending-plan",
        created_at: updatedAt,
        iteration_count: 0,
        observations: [],
        decisions: [],
        blockers: [],
        results: null,
        next_intent: "",
        consolidated_summary: null,
        relevant_tools: child.relevant_tools,
        relevant_skills: child.relevant_skills,
      }
      await NodeFS.write(opts.sessionId, childNode, opts.dataHome)
    }

    const updatedNode: ContextNode = {
      ...node,
      children_ids: [...node.children_ids, ...newChildIds],
      mode: "decomposed",
      iteration_count: node.iteration_count + 1,
      updated_at: updatedAt,
    }
    await NodeFS.write(opts.sessionId, updatedNode, opts.dataHome)

    await FreerunBus.emit.childrenPlanned({
      sessionID: opts.sessionId,
      iteration,
      parentNodeID: node.id,
      childIDs: newChildIds,
      childTitles,
    })
    await emitTransition(opts.sessionId, iteration, node.id, node.mode, "decomposed", "planning iteration emitted children")
    await FreerunBus.emit.iterationCompleted({
      sessionID: opts.sessionId,
      iteration,
      nodeID: node.id,
      latencyMs: Date.now() - t0,
      validationResult: "ok",
    })

    return { kind: "advanced", nodeId: node.id, mode: "planning" }
  }

  // ============================================================================
  // Execution path (Option D — Claude-style trust + post-parse, 1 retry)
  // ============================================================================

  async function runExecution(
    opts: IterateOptions,
    node: ContextNode,
    navBandText: string,
    detailText: string,
    now: () => string,
    iteration: number,
  ): Promise<IterateResult> {
    const filtered = ToolFilter.filter(opts.toolCatalog, { relevantTools: node.relevant_tools })

    const tpl = PromptTemplate.render({
      navBandText,
      nodeDetailText: detailText,
      mode: "execution",
      strictness: opts.config.prompt_strictness,
      agentsMdContent: opts.agentsMdContent,
      systemMdContent: opts.systemMdContent,
    })

    await FreerunBus.emit.iterationPromptBuilt({
      sessionID: opts.sessionId,
      iteration,
      schemaName: tpl.responseSchemaName,
      schemaSizeBytes: JSON.stringify(tpl.responseSchema).length,
      messagesLength: 2,
    })

    const baseReq: ExecutionRequest = {
      systemPrompt: tpl.systemPrompt,
      userMessage: tpl.userMessage,
      tools: filtered.tools,
      toolsSuppressed: filtered.suppressAll,
      temperature: opts.config.mode_dispatch_temperature_exec,
    }

    const t0 = Date.now()

    // First attempt
    let outcome: ExecutionOutcome | null = null
    let failures: string[] = []
    let validationResult: "ok" | "retry-succeeded" | "blocked" = "ok"
    try {
      const raw = await opts.llm.callExecution(baseReq)
      outcome = parseExecutionOutcome(raw.finalContent)
    } catch (err) {
      failures.push(`first attempt: ${formatError(err)}`)
    }

    // One retry with stricter framing if first attempt failed Zod
    if (outcome === null) {
      await FreerunBus.emit.llmValidationRetry({
        sessionID: opts.sessionId,
        iteration,
        attemptNumber: 1,
        validationErrors: failures.length > 0 ? failures : ["unparseable output"],
      })
      validationResult = "retry-succeeded"
      const retryReq: ExecutionRequest = {
        ...baseReq,
        userMessage:
          baseReq.userMessage +
          "\n\n# Retry — output format violation\n" +
          "Your previous response did not parse as ExecutionOutcome JSON. " +
          "Emit ONLY a valid ExecutionOutcome JSON object now, no prose, no code fences.",
      }
      try {
        const raw = await opts.llm.callExecution(retryReq)
        outcome = parseExecutionOutcome(raw.finalContent)
      } catch (err) {
        failures.push(`retry: ${formatError(err)}`)
      }
    }

    if (outcome === null) {
      validationResult = "blocked"
      const reason = `execution output did not parse after 1 retry — ${failures.join("; ")}`
      await FreerunBus.emit.iterationHalted({
        sessionID: opts.sessionId,
        iteration,
        nodeID: node.id,
        reason,
        errors: failures,
      })
      return blockNode(opts, node, now, reason, iteration)
    }

    // Persist outcome
    const updatedAt = now()
    const nextMode = outcome.next_mode === "pending-plan" ? "pending-plan" : outcome.next_mode
    const merged: ContextNode = {
      ...node,
      mode: nextMode,
      iteration_count: node.iteration_count + 1,
      updated_at: updatedAt,
      // Append (not replace) state payload — cross-iteration coherence on this node.
      observations: [...node.observations, ...outcome.observations],
      decisions: [...node.decisions, ...outcome.decisions],
      blockers: nextMode === "blocked"
        ? [...node.blockers, ...outcome.blockers]
        : outcome.blockers, // on non-blocked completion, replace with current iteration's blocker view
      results: outcome.results ?? node.results,
      next_intent: outcome.next_intent,
    }
    await NodeFS.write(opts.sessionId, merged, opts.dataHome)

    // Emit per-element cognitive events.
    for (const obs of outcome.observations) {
      await FreerunBus.emit.observationRecorded({
        sessionID: opts.sessionId,
        iteration,
        nodeID: node.id,
        observationText: obs,
      })
    }
    for (const d of outcome.decisions) {
      await FreerunBus.emit.decisionEmitted({
        sessionID: opts.sessionId,
        iteration,
        nodeID: node.id,
        decisionID: `${node.id}-${node.iteration_count + 1}-d${outcome.decisions.indexOf(d)}`,
        decisionText: d.decision,
        rationale: d.rationale,
      })
    }
    for (const b of outcome.blockers) {
      await FreerunBus.emit.blockerRaised({
        sessionID: opts.sessionId,
        iteration,
        nodeID: node.id,
        blockerText: b,
        severity: nextMode === "blocked" ? "hard" : "soft",
      })
    }
    if (nextMode === "pending-plan") {
      await FreerunBus.emit.replanTriggered({
        sessionID: opts.sessionId,
        iteration,
        nodeID: node.id,
        triggerReason: "execution outcome next_mode=pending-plan",
        invalidatedAssumptions: [],
      })
    }
    await emitTransition(opts.sessionId, iteration, node.id, node.mode, nextMode, "execution iteration outcome")
    await FreerunBus.emit.iterationCompleted({
      sessionID: opts.sessionId,
      iteration,
      nodeID: node.id,
      latencyMs: Date.now() - t0,
      validationResult,
    })

    return { kind: "advanced", nodeId: node.id, mode: "execution" }
  }

  // ============================================================================
  // Helpers
  // ============================================================================

  function parseExecutionOutcome(content: string): ExecutionOutcome | null {
    const trimmed = stripFencingAndPreamble(content)
    if (trimmed === null) return null
    try {
      const obj = JSON.parse(trimmed)
      return ExecutionOutcome.parse(obj)
    } catch {
      return null
    }
  }

  /**
   * Take a model's final content and extract the JSON object portion.
   * Handles common framings: bare JSON, fenced ```json ... ```, fenced ``` ... ```,
   * or prose-with-trailing-JSON.
   */
  function stripFencingAndPreamble(s: string): string | null {
    const fenceMatch = s.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/i)
    if (fenceMatch) return fenceMatch[1].trim()
    // Find the outermost {...}.
    const start = s.indexOf("{")
    const end = s.lastIndexOf("}")
    if (start === -1 || end === -1 || end <= start) return null
    return s.slice(start, end + 1).trim()
  }

  /** Ensure a child id is namespaced under its parent (defensive against model emitting bare ids). */
  function ensureNamespacedChildId(parentId: string, childIdFromLlm: string): string {
    if (childIdFromLlm.startsWith(parentId + ".")) return childIdFromLlm
    if (childIdFromLlm === parentId) return `${parentId}.child`
    return `${parentId}.${childIdFromLlm}`
  }

  async function blockNode(
    opts: IterateOptions,
    node: ContextNode,
    now: () => string,
    reason: string,
    iteration: number,
  ): Promise<IterateResult> {
    const updatedAt = now()
    const blocked: ContextNode = {
      ...node,
      mode: "blocked",
      iteration_count: node.iteration_count + 1,
      updated_at: updatedAt,
      blockers: [...node.blockers, reason],
    }
    await NodeFS.write(opts.sessionId, blocked, opts.dataHome)
    await emitTransition(opts.sessionId, iteration, node.id, node.mode, "blocked", reason)
    return { kind: "blocked", nodeId: node.id, reason }
  }

  async function emitTransition(
    sessionID: string,
    iteration: number,
    nodeId: string,
    fromMode: NodeMode,
    toMode: NodeMode,
    reason: string,
  ): Promise<void> {
    if (fromMode === toMode) return
    await FreerunBus.emit.nodeStateTransition({
      sessionID,
      iteration,
      nodeID: nodeId,
      fromMode,
      toMode,
      reason,
    })
  }

  function defaultNowIso(): string {
    return new Date().toISOString()
  }

  function formatError(err: unknown): string {
    if (err instanceof Error) return err.message
    return String(err)
  }
}
