// Phase B types for the user-role context preface (DD-1 / DD-4 / DD-5 of
// specs/prompt-cache-and-compaction-hardening). Pure type module — no runtime,
// no Bus subscriptions, no side effects on import.
//
// Mirrors the data-schema.json definitions in the spec package. Producers
// (context-preface.ts, preloaded-context.ts) emit these structures;
// consumers (llm.ts, plugin hooks, transform.ts cache breakpoint allocator)
// read them.

/** A single skill entry rendered into the preface T2 segment. */
export interface SkillContextEntry {
  name: string
  state: "pinned" | "active" | "summary"
  /** Full body for active/pinned; purpose+keepRules for summary. */
  content: string
  loadedAt?: number
  lastUsedAt?: number
}

/**
 * Inputs collected from the live session, partitioned by change frequency
 * (DD-1 tier ranking). Producers populate this; consumers serialize it into
 * a single user-role message with multiple text content blocks.
 */
export interface ContextPrefaceParts {
  /** Tier 1 (session-stable): README / cwd / pinned skills / today's date. */
  t1: {
    readmeSummary: string
    cwdListing: string
    pinnedSkills: SkillContextEntry[]
    /** ISO date string (YYYY-MM-DD). Always last in T1 per DD-2. */
    todaysDate: string
  }
  /** Tier 2 (decay-tier): active + summarized skills. */
  t2: {
    activeSkills: SkillContextEntry[]
    summarizedSkills: SkillContextEntry[]
  }
}

/**
 * Per-tier output of preloaded-context.ts (PreloadProvider). Producers MUST
 * keep this structured rather than emitting a single string so the preface
 * builder can place tier-aware cache breakpoints (DD-3).
 */
export interface PreloadParts {
  readmeSummary: string
  cwdListing: string
}

/**
 * One content block inside the context-preface user message. Tier marker
 * lets the cache breakpoint allocator place BP2 (T1 end) and BP3 (T2 end).
 *
 * "trailing" tier carries per-turn extras (lazy catalog hints, structured-
 * output directives, subagent notices). It rides the per-turn cache
 * naturally — no dedicated breakpoint, follows the user message into BP4.
 */
export type PrefaceContentBlock =
  | { type: "text"; tier: "t1" | "t2" | "trailing"; text: string }
  /**
   * attachment-lifecycle v4 (DD-19/DD-20): inline image binary block placed
   * in the preface trailing tier (BP4 zone). Per-turn churn here does not
   * disturb T1/T2 cache prefix.
   */
  | { type: "file"; tier: "trailing"; url: string; mediaType: string; filename: string }

/**
 * Marker constant exposed for downstream consumers (UI, replay, compaction)
 * that need to identify preface messages without importing the schema. The
 * literal value matches `MessageV2.User.kind`.
 */
export const CONTEXT_PREFACE_KIND = "context-preface" as const
export type ContextPrefaceKind = typeof CONTEXT_PREFACE_KIND

/**
 * R1 mitigation directive (DD-1 + Phase B v2 recalibration 2026-05-04). The
 * preface body opens with this line so the LLM treats the user-role message
 * as instruction-bearing context rather than free-form chat. Baked into the
 * design instead of validated by post-hoc A/B test.
 */
export const PREFACE_DIRECTIVE_HEADER = "## CONTEXT PREFACE — read but do not echo"
