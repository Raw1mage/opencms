/**
 * harness/freerun-mode — mode-specific prompt assembly (DD-3d).
 *
 * Each iteration produces ONE LLM request. The request shape is:
 *
 *   system: <fixed role description + schema enforcement instruction>
 *   user:   <nav band> + <node detail block> + <mode-specific charge>
 *   response_format: json_schema derived from PlanningOutcome | ExecutionOutcome
 *
 * Modes:
 *   - planning  (node.mode = pending-plan)  → emit children[]
 *   - execution (node.mode = pending-exec)  → emit observations/decisions/blockers/results/next_intent/next_mode
 *
 * The model NEVER sees prior message history — every iteration is a fresh
 * prompt synthesized from the current ContextNode tree (the stateless
 * iteration invariant; founding architectural premise per DD-9).
 */

import z from "zod"
import { ExecutionOutcome, PlanningOutcome } from "../types"

export namespace PromptTemplate {
  export type IterationMode = "planning" | "execution"

  export interface RenderInput {
    /** Output of NavigationBand.render(). */
    navBandText: string
    /** Output of NodeDetail.render(). */
    nodeDetailText: string
    /** Which kind of iteration to charge the model with. */
    mode: IterationMode
    /** ExperimentConfig.prompt_strictness — adjusts wording strictness. */
    strictness: "loose" | "medium" | "strict"
    /**
     * Project conventions text (typically from AGENTS.md). Injected near
     * the top of the user message so the model sees it before navigation
     * band. Empty/undefined skips the block. Engine.run loads
     * ~/.config/opencode/AGENTS.md + <project>/AGENTS.md and concatenates.
     */
    agentsMdContent?: string
    /**
     * Master operational rules (typically SYSTEM.md). Injected into the
     * SYSTEM prompt itself, after the role+mode header. Critical for
     * freerun-mode sessions: AGENTS.md is project rules, SYSTEM.md is
     * red-light rules / tool governance / autorun discipline. Empty
     * skips. Engine.run loads from user override
     * (~/.config/opencode/prompts/SYSTEM.md) with installed fallback.
     */
    systemMdContent?: string
  }

  export interface RenderOutput {
    systemPrompt: string
    userMessage: string
    /** JSON schema for response_format (OpenAI-style json_schema mode). */
    responseSchema: unknown
    /** Schema name (for OpenAI response_format.json_schema.name). */
    responseSchemaName: string
  }

  // Pre-compute JSON schemas at module load (cheap; pure data).
  // Zod 4 ships `z.toJSONSchema()` natively — produces JSON Schema 2020-12.
  const PLANNING_JSON_SCHEMA = z.toJSONSchema(PlanningOutcome)
  const EXECUTION_JSON_SCHEMA = z.toJSONSchema(ExecutionOutcome)

  export function render(input: RenderInput): RenderOutput {
    const systemPrompt = buildSystemPrompt(input.mode, input.strictness, input.systemMdContent)
    const userMessage = buildUserMessage(input.navBandText, input.nodeDetailText, input.mode, input.agentsMdContent)
    const responseSchema = input.mode === "planning" ? PLANNING_JSON_SCHEMA : EXECUTION_JSON_SCHEMA
    const responseSchemaName = input.mode === "planning" ? "PlanningOutcome" : "ExecutionOutcome"
    return { systemPrompt, userMessage, responseSchema, responseSchemaName }
  }

  // ============================================================================
  // System prompt
  // ============================================================================

  function buildSystemPrompt(
    mode: IterationMode,
    strictness: "loose" | "medium" | "strict",
    systemMdContent?: string,
  ): string {
    const role = [
      "You are one iteration of an autonomous freerun-mode agent.",
      "Each iteration is independent — you do NOT see your own previous prompts or responses.",
      "All state lives in the per-node ContextNode tree the user message describes.",
      "Your job this iteration is to act on the CURRENT NODE described below.",
    ].join(" ")

    const modeCharge =
      mode === "planning"
        ? [
            "MODE: planning. You will decompose the current node into 1+ children.",
            "The root goal may come from a live conversation-goal or a plan-anchored tasks.md item.",
            "Children are concrete sub-steps; emit only what is actually needed — no filler.",
            "Decompose BELOW the current goal/task boundary; do not redefine, replace, or escape that boundary.",
            "ICOM, ContextNode, PlanningOutcome, ExecutionOutcome, JSON output, and handover/state updates are runtime commit protocol, NOT child tasks.",
            "For each child, give: id (lowercase kebab/dot path under the current node id), title, brief body.",
            "If a child still needs further decomposition, omit `mode` (engine picks pending-plan).",
            "If a child is ready for direct execution with tools, set `mode: \"pending-exec\"`.",
            "Optionally pre-declare `relevant_tools` and `relevant_skills` for each child (DD-19 / DD-26).",
          ].join(" ")
        : [
            "MODE: execution. You will act on the current node using available tools.",
            "Record every meaningful observation in `observations` (concise strings, one per insight).",
            "Record every non-obvious decision in `decisions` with `rationale` (>= 10 chars) — DD-2.",
            "Record any obstacle that prevents progress in `blockers`.",
            "If you produce a concrete artifact (file path, value, structured data), put it in `results`.",
            "State your next_intent (one short line) so the next iteration on this node has continuity.",
            "Set `next_mode`: `done` if this node is complete; `blocked` if you cannot proceed; `pending-plan` if you discovered the plan needs refinement.",
          ].join(" ")

    const schemaCharge =
      strictness === "loose"
        ? "Return a JSON object matching the response schema. Extra prose outside JSON is ignored."
        : "Return ONLY a JSON object matching the response schema. No prose before or after the JSON. The transport enforces this via json_schema response_format."

    const parts = [role, "", modeCharge, "", schemaCharge]
    if (systemMdContent && systemMdContent.trim().length > 0) {
      parts.push("")
      parts.push("# Operational rules (binding — apply to every action)")
      parts.push(systemMdContent.trim())
    }
    return parts.join("\n")
  }

  // ============================================================================
  // User message
  // ============================================================================

  function buildUserMessage(
    navBandText: string,
    nodeDetailText: string,
    mode: IterationMode,
    agentsMdContent?: string,
  ): string {
    const parts: string[] = []
    if (agentsMdContent && agentsMdContent.trim().length > 0) {
      parts.push("# Project conventions (AGENTS.md — read carefully, applies to every action)")
      parts.push(agentsMdContent.trim())
      parts.push("")
    }
    if (navBandText.length > 0) {
      parts.push(navBandText.trimEnd())
      parts.push("")
    }
    parts.push(nodeDetailText.trimEnd())
    parts.push("")
    parts.push("# Your task")
    parts.push(
      mode === "planning"
        ? "Decompose the current node into actionable domain children. Do not create children for producing ICOM/ContextNode/JSON/handover state; those are this iteration's commit protocol. Emit a PlanningOutcome JSON."
        : "Execute the current node using tools where appropriate, then emit an ExecutionOutcome JSON capturing what happened.",
    )
    return parts.join("\n")
  }
}
