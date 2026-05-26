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
import {
  ContextNode,
  ExecutionOutcome,
  PlanningOutcome,
  type ExperimentConfig,
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
    /** Wall-clock now() in ISO format — injectable for deterministic tests. */
    nowIso?: () => string
  }

  export type IterateResult =
    | { kind: "advanced"; nodeId: string; mode: "planning" | "execution" }
    | { kind: "settled" }
    | { kind: "blocked"; nodeId: string; reason: string }

  /** Run exactly one iteration. Returns the result; does not loop. */
  export async function once(opts: IterateOptions): Promise<IterateResult> {
    const now = opts.nowIso ?? defaultNowIso
    const tree = await Tree.load(opts.sessionId, opts.dataHome)
    const pick = PickNext.pick(tree, opts.config)
    if (pick.kind === "settled") return { kind: "settled" }
    const node = pick.node

    // Step 1: render context
    const navBand = NavigationBand.render(tree, node.id, {
      policy: opts.config.nav_band_policy,
      tokenBudget: opts.config.nav_band_token_budget,
    })
    const detail = NodeDetail.render(node)

    // Step 2-4: mode dispatch
    if (node.mode === "pending-plan") {
      return runPlanning(opts, node, navBand.text, detail.text, now)
    }
    // pending-exec / doing → execution path
    return runExecution(opts, node, navBand.text, detail.text, now)
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
  ): Promise<IterateResult> {
    const tpl = PromptTemplate.render({
      navBandText,
      nodeDetailText: detailText,
      mode: "planning",
      strictness: opts.config.prompt_strictness,
    })
    const req: PlanningRequest = {
      systemPrompt: tpl.systemPrompt,
      userMessage: tpl.userMessage,
      responseSchema: tpl.responseSchema,
      responseSchemaName: tpl.responseSchemaName,
      temperature: opts.config.mode_dispatch_temperature_plan,
    }
    let outcome: PlanningOutcome
    try {
      const raw = await opts.llm.callPlanning(req)
      outcome = PlanningOutcome.parse(raw) // belt-and-suspenders even though server enforced schema
    } catch (err) {
      return blockNode(opts, node, now, `planning LLM call failed: ${formatError(err)}`)
    }

    // Persist children
    const updatedAt = now()
    const newChildIds: string[] = []
    for (const child of outcome.children) {
      const id = ensureNamespacedChildId(node.id, child.id)
      newChildIds.push(id)
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
  ): Promise<IterateResult> {
    const filtered = ToolFilter.filter(opts.toolCatalog, { relevantTools: node.relevant_tools })

    const tpl = PromptTemplate.render({
      navBandText,
      nodeDetailText: detailText,
      mode: "execution",
      strictness: opts.config.prompt_strictness,
    })

    const baseReq: ExecutionRequest = {
      systemPrompt: tpl.systemPrompt,
      userMessage: tpl.userMessage,
      tools: filtered.tools,
      toolsSuppressed: filtered.suppressAll,
      temperature: opts.config.mode_dispatch_temperature_exec,
    }

    // First attempt
    let outcome: ExecutionOutcome | null = null
    let failures: string[] = []
    try {
      const raw = await opts.llm.callExecution(baseReq)
      outcome = parseExecutionOutcome(raw.finalContent)
    } catch (err) {
      failures.push(`first attempt: ${formatError(err)}`)
    }

    // One retry with stricter framing if first attempt failed Zod
    if (outcome === null) {
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
      return blockNode(
        opts,
        node,
        now,
        `execution output did not parse after 1 retry — ${failures.join("; ")}`,
      )
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
    return { kind: "blocked", nodeId: node.id, reason }
  }

  function defaultNowIso(): string {
    return new Date().toISOString()
  }

  function formatError(err: unknown): string {
    if (err instanceof Error) return err.message
    return String(err)
  }
}
