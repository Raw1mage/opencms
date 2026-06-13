/**
 * harness/freerun-mode — shared types and Zod schemas.
 *
 * Single source of truth for all freerun-mode data shapes:
 *   - ContextNode (the unified plan-structure-plus-state-payload model, DD-3a)
 *   - DecisionEntry (Cognition warning operationalized via rationale field, DD-2)
 *   - SessionStartContext (uniform trigger output, A1)
 *   - FreerunSessionMeta (persisted at meta.json per session)
 *   - ExperimentConfig (the dial surface for ablation experiments, DD-18)
 *
 * Zod schemas live here; derive types via z.infer; derive JSON schemas
 * (for LLM response_format) at call sites via zodToJsonSchema-style helper
 * if/when needed. We avoid eager JSON schema export to keep this file
 * runtime-cheap and dependency-light.
 *
 * Companion artifact: plans/harness_freerun-mode/data-schema.json
 */

import z from "zod"

// ============================================================================
// Node mode enum
// ============================================================================

export const NodeMode = z.enum([
  "pending-plan",   // needs planning iteration to emit children
  "pending-exec",   // ready for execution iteration
  "doing",          // atomic in-progress marker (rarely persisted; mostly transient)
  "decomposed",    // children present; node itself not directly executed
  "done",           // terminal success
  "blocked",        // terminal failure (re-plannable from parent)
])
export type NodeMode = z.infer<typeof NodeMode>

// ============================================================================
// DecisionEntry (DD-2: decisions carry rationale; validator enforces min length)
// ============================================================================

export const DecisionEntry = z.object({
  decision: z.string().min(1),
  rationale: z.string().min(10), // Cognition warning operationalized; min char overridable by ExperimentConfig.decision_rationale_min_chars
})
export type DecisionEntry = z.infer<typeof DecisionEntry>

// ============================================================================
// GoalBinding (plan-compatible admission source)
// ============================================================================

export const GoalBinding = z.discriminatedUnion("source", [
  z.object({
    source: z.literal("conversation-goal"),
    goal_text: z.string().min(1),
  }),
  z.object({
    source: z.literal("plan-task"),
    plan_slug: z.string().min(1),
    task_id: z.string().min(1),
    task_text: z.string().min(1),
    acceptance_criteria: z.array(z.string().min(1)).default([]),
  }),
])
export type GoalBinding = z.infer<typeof GoalBinding>

// ============================================================================
// ContextNode (DD-3a — structure + state payload as one object)
// ============================================================================

export const ContextNode = z.object({
  // === structure (relatively stable after creation) ===
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/, "node id must match /^[a-z0-9][a-z0-9._-]*$/"),
  parent_id: z.string().nullable(),
  children_ids: z.array(z.string()).default([]),
  title: z.string().min(1),
  body: z.string().default(""),
  mode: NodeMode,
  created_at: z.string(), // ISO timestamp
  iteration_count: z.number().int().min(0).default(0),

  // === state payload (changes per iteration) ===
  updated_at: z.string().optional(),
  observations: z.array(z.string().min(1)).default([]),
  decisions: z.array(DecisionEntry).default([]),
  blockers: z.array(z.string().min(1)).default([]),
  results: z.unknown().nullable().default(null),
  next_intent: z.string().default(""),
  consolidated_summary: z.string().nullable().default(null),

  // === DD-19 dynamic tool loading (planning-time freeze) ===
  relevant_tools: z.array(z.string()).optional(),
  // DD-26 dynamic skill loading (planning-time freeze; existing skill system also auto-triggers)
  relevant_skills: z.array(z.string()).optional(),

  // Plan-compatible admission source. Roots may be seeded from a live
  // conversation goal or from a plan-builder tasks.md item; child nodes inherit
  // the boundary implicitly through their ancestor chain.
  goal_binding: GoalBinding.optional(),
})
export type ContextNode = z.infer<typeof ContextNode>

// ============================================================================
// SessionStartContext (A1 trigger output)
// ============================================================================

export const TriggerMode = z.enum(["cron", "watchdog", "goal"])
export type TriggerMode = z.infer<typeof TriggerMode>

export const SessionStartContext = z.object({
  session_id: z.string().regex(/^[a-z0-9-]+$/),
  trigger_mode: TriggerMode,
  trigger_payload: z.record(z.string(), z.unknown()),
  initial_goal: z.string().optional(),
  provider_id: z.string(),
  user_id: z.string(),
})
export type SessionStartContext = z.infer<typeof SessionStartContext>

// ============================================================================
// ExperimentConfig (DD-18 — the dial surface)
// ============================================================================

export const ExperimentConfig = z.object({
  // Pick-next policy (DD-3b)
  top_levels_to_plan: z.number().int().min(0).default(3),

  // Navigation band (DD-3e)
  nav_band_policy: z.enum(["full", "parent-only", "minimal", "off"]).default("full"),
  nav_band_token_budget: z.number().int().min(0).default(500),

  // Iteration bounds (DD-24)
  iteration_cap: z.number().int().min(1).default(500),
  http_timeout_seconds: z.number().int().min(5).default(120),
  iteration_max_wall_seconds: z.number().int().min(10).default(300),

  // Validation discipline (DD-2 + DD-4)
  decision_rationale_min_chars: z.number().int().min(0).default(10),

  // Consolidation (DD-3c)
  consolidation_threshold: z.enum(["100%", "80%", "50%", "off"]).default("100%"),
  summary_token_cap_consolidation: z.number().int().min(50).default(300),

  // Re-plan (DD-3d / DD-19 reactivity)
  replan_trigger_sensitivity: z
    .enum(["first_surprise", "repeated", "explicit_blocker", "never"])
    .default("first_surprise"),

  // Tool / skill catalog (DD-19, DD-26)
  tools_allowed: z.enum(["full", "restricted", "minimal", "none"]).default("full"),
  skill_triggering_enabled: z.boolean().default(true),
  skill_catalog_token_budget: z.number().int().min(0).default(1500),

  // Mode dispatch (DD-3d)
  planning_mode_allowed: z.boolean().default(true),
  mode_dispatch_temperature_plan: z.number().min(0).max(2).default(0.4),
  mode_dispatch_temperature_exec: z.number().min(0).max(2).default(0.7),

  // Strictness (DD-4 / ExperimentConfig general)
  prompt_strictness: z.enum(["loose", "medium", "strict"]).default("medium"),
})
export type ExperimentConfig = z.infer<typeof ExperimentConfig>

/** Compute a stable id for a frozen config (for experiment_config_id telemetry header). */
export function hashExperimentConfig(cfg: ExperimentConfig): string {
  // Deterministic stringification (sorted keys) → SHA-1 short hash via Bun.CryptoHasher.
  // We use SHA-1 here for brevity and cross-platform availability; collision risk is
  // irrelevant for an opaque correlation id of a tiny known config object.
  const sortedKeys = Object.keys(cfg).sort()
  const sortedObj = Object.fromEntries(sortedKeys.map((k) => [k, (cfg as Record<string, unknown>)[k]]))
  const text = JSON.stringify(sortedObj)
  if (typeof Bun !== "undefined") {
    const hasher = new Bun.CryptoHasher("sha1")
    hasher.update(text)
    return hasher.digest("hex").slice(0, 16)
  }
  // Node fallback (tests / non-Bun env)
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHash } = require("crypto") as typeof import("crypto")
  return createHash("sha1").update(text).digest("hex").slice(0, 16)
}

// ============================================================================
// FreerunSessionMeta (persisted at meta.json per session)
// ============================================================================

export const FreerunFinalStatus = z.enum([
  "in_progress",
  "done",
  "blocked",
  "cap_reached",
  "paused",
  "user_interrupted",
  "error",
])
export type FreerunFinalStatus = z.infer<typeof FreerunFinalStatus>

export const FreerunSessionMeta = z.object({
  session_id: z.string(),
  trigger_mode: TriggerMode,
  provider_id: z.string(),
  user_id: z.string(),
  root_node_id: z.string(),
  started_at: z.string(),
  ended_at: z.string().optional(),
  final_status: FreerunFinalStatus.default("in_progress"),
  total_iterations: z.number().int().min(0).default(0),

  // Frozen at A2.1 per DD-18 / R14; immutable thereafter
  experiment_config: ExperimentConfig,
  experiment_config_id: z.string(),

  // Protocol version (cross-spec contract with aisecurity per observability.md §Versioning)
  protocol_version: z.literal("v0").default("v0"),

  // DD-24 liveness — engine heartbeats here every N iterations for crash detection
  heartbeat_at: z.string().optional(),

  // Token totals (terminal write; for at-glance inspection; derivable from event log)
  total_tokens_input: z.number().int().min(0).optional(),
  total_tokens_output: z.number().int().min(0).optional(),
})
export type FreerunSessionMeta = z.infer<typeof FreerunSessionMeta>

// ============================================================================
// LLM iteration output schemas (mode-dispatched per DD-3d)
// ============================================================================

/** What a planning iteration LLM emits — children to add under the current node. */
export const PlanningOutcome = z.object({
  children: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
        title: z.string().min(1),
        body: z.string().default(""),
        mode: NodeMode.optional(), // omitted → engine picks pending-plan or pending-exec by LLM hint
        relevant_tools: z.array(z.string()).optional(),
        relevant_skills: z.array(z.string()).optional(),
      }),
    )
    .min(1),
})
export type PlanningOutcome = z.infer<typeof PlanningOutcome>

/** What an execution iteration LLM emits — observations + decisions + result. */
export const ExecutionOutcome = z.object({
  observations: z.array(z.string().min(1)).default([]),
  decisions: z.array(DecisionEntry).default([]),
  blockers: z.array(z.string().min(1)).default([]),
  results: z.unknown().nullable().default(null),
  next_intent: z.string().default(""),
  next_mode: z.enum(["done", "blocked", "pending-plan"]).default("done"),
})
export type ExecutionOutcome = z.infer<typeof ExecutionOutcome>

// ============================================================================
// Storage path helpers
// ============================================================================

/** Per-session storage directory under Global.Path.data. */
export function sessionStorageDir(sessionId: string, dataHome: string): string {
  return `${dataHome}/storage/freerun/${sessionId}`
}

/** Per-node markdown file path within a session. */
export function nodeFilePath(sessionId: string, nodeId: string, dataHome: string): string {
  return `${sessionStorageDir(sessionId, dataHome)}/tree/${nodeId}.md`
}
