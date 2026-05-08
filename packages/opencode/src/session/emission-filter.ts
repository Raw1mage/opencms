/**
 * compaction-fix Phase 1 — emission filter (defense-in-depth).
 *
 * Detects assistant text parts that match known LLM regurgitation /
 * misemission patterns. The runtime marks matching parts `ignored: true`
 * so they (a) are filtered out of subsequent prompt assembly and (b)
 * do not render in TUI / webapp surfaces. The text content remains
 * persisted in the session DB for forensic inspection.
 *
 * 2026-05-08 motivation: even after the upstream-aligned drop semantics
 * (post-anchor-transform.ts v2) prevent NEW regurgitation, three classes
 * of garbage still leak into completed text parts:
 *
 *   1. **Phase 1 v1 trace-marker mimicry** (legacy):
 *      Model saw `[turn N] tool(args) → ref:call_xyz; ...` in its own
 *      assistant role history (because v1 collapsed past turns into a
 *      synthetic text part) and emitted the same shape as new output.
 *      Already-persisted parts retain this garbage.
 *
 *   2. **Line-numbered file dump regurgitation**:
 *      Model attends to a long prior `read()` tool result containing
 *      `\d{4,6}\|\s` line-number prefixes and reproduces a chunk as
 *      its own response text under context-overflow stress.
 *
 *   3. **`cache-digest` fenced block in main text channel**:
 *      Per `plans/20260507_working-cache-local-cache/` DD-9 the digest
 *      fenced block is supposed to be emitted in the reasoning channel
 *      (where webapp collapses it by default). When the model misroutes
 *      it into the main text channel it surfaces as raw JSON the user
 *      sees as garbage.
 *
 * The filter is a pure function — no I/O, no side effects. The caller
 * applies the result by setting `MessageV2.TextPart.ignored = true`.
 */

const TRACE_MARKER_PATTERN = /^\[turn\s+\d+\]\s+\w+\(/m
const TRACE_MARKER_REF_PATTERN = /\bref:call_[A-Za-z0-9]{6,}/

/**
 * Match 3+ consecutive lines of the form `<digits>| <content>` where
 * `<digits>` is 4–6 chars. Captures both `08571| ...` (read tool dump)
 * and `Line 1234: ...` style grep dumps that the model verbatim copies.
 */
const LINE_NUMBERED_DUMP_PATTERN =
  /(?:^|\n)\s*\d{4,6}\|\s.{0,400}(?:\n\s*\d{4,6}\|\s.{0,400}){2,}/

const CACHE_DIGEST_FENCE_PATTERN = /```cache-digest\b/

export interface EmissionDetection {
  hidden: boolean
  reason: "trace_marker" | "line_numbered_dump" | "cache_digest_fence" | null
}

const RESULT_CLEAN: EmissionDetection = Object.freeze({ hidden: false, reason: null })

/**
 * Determine whether a finalized assistant text part should be hidden.
 * Returns `{ hidden: true, reason }` when matched, otherwise `{ hidden: false }`.
 *
 * Each pattern is independently scanned — first match wins so the reason
 * code is deterministic.
 */
export function detectEmissionGarbage(text: string): EmissionDetection {
  if (typeof text !== "string" || text.length === 0) return RESULT_CLEAN

  // Trace-marker pattern requires BOTH the `[turn N] tool(` opener AND
  // a `ref:call_*` payload. The opener alone matches legitimate prose
  // ("[turn 5] is the round we left off in"); the ref token is the
  // give-away that this is a regurgitated runtime annotation.
  if (TRACE_MARKER_PATTERN.test(text) && TRACE_MARKER_REF_PATTERN.test(text)) {
    return { hidden: true, reason: "trace_marker" }
  }

  if (LINE_NUMBERED_DUMP_PATTERN.test(text)) {
    return { hidden: true, reason: "line_numbered_dump" }
  }

  if (CACHE_DIGEST_FENCE_PATTERN.test(text)) {
    return { hidden: true, reason: "cache_digest_fence" }
  }

  return RESULT_CLEAN
}
