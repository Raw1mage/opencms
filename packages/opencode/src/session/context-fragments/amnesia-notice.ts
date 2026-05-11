/**
 * AmnesiaNotice fragment (compaction/recall-affordance L3).
 *
 * Injected as a user-role context fragment when the session's most recent
 * compaction event indicates narrative-kind anchor. Tells the model that
 * its pre-anchor tool history has been collapsed into prose and points it
 * at the TOOL_INDEX + recall tool for recovery.
 *
 * Source: opencode-only (no upstream codex-cli analog — codex's
 * previous_response_id mechanism makes this notice unnecessary there).
 *
 * Re-injected every turn until a non-narrative compaction event supersedes
 * the current narrative one in recentEvents (policy
 * `session_stable_until_next_anchor`).
 */

import type { ContextFragment } from "./fragment"

/**
 * Decision helper — pure. Given a session's recentEvents ring buffer,
 * decide whether the amnesia notice should be injected this turn.
 *
 * Rule: scan recentEvents in reverse; find the most recent event with
 * `kind === "compaction"`. If that event's `compaction.kind === "narrative"`,
 * the active anchor is narrative-kind → return true. Any later non-narrative
 * compaction event supersedes the narrative one → return false.
 *
 * Returns the matched event when truthy so callers can thread anchor metadata
 * into the fragment body.
 */
export interface AmnesiaDecision {
  inject: boolean
  /** Compaction event timestamp, when inject=true. */
  ts?: number
  /** Anchor kind string, when inject=true. */
  anchorKind?: string
}

/**
 * Compaction kinds that perform client-side summarisation — pre-anchor tool
 * results collapse into prose and the AI loses addressability unless the
 * recall affordance is surfaced.
 *
 * `low-cost-server` (codex /responses/compact path) is the only kind that
 * preserves a server-side previous_response_id chain; the AI sees no
 * perceptible gap there, so we skip the notice.
 */
const CLIENT_SIDE_COMPACTION_KINDS = new Set(["narrative", "hybrid_llm", "replay-tail", "llm-agent"])

export function decideAmnesiaInjection(
  recentEvents: ReadonlyArray<{
    ts: number
    kind: "rotation" | "compaction"
    compaction?: { observed: string; kind?: string; success: boolean }
  }> | undefined,
): AmnesiaDecision {
  if (!recentEvents || recentEvents.length === 0) return { inject: false }
  for (let i = recentEvents.length - 1; i >= 0; i--) {
    const e = recentEvents[i]
    if (e.kind !== "compaction") continue
    const c = e.compaction
    if (!c || c.success !== true) {
      // unsuccessful compaction — does not affect the active anchor; keep scanning
      continue
    }
    if (c.kind && CLIENT_SIDE_COMPACTION_KINDS.has(c.kind)) {
      return { inject: true, ts: e.ts, anchorKind: c.kind }
    }
    // Server-side / unknown kind — assume the chain is preserved; no notice.
    return { inject: false }
  }
  return { inject: false }
}

export interface AmnesiaNoticeInput {
  /** id of the narrative anchor message that produced this notice. Optional — used in the body for traceability. */
  anchorId?: string
  /** kind value from recentEvents (typically "narrative"). */
  anchorKind?: string
}

export const AMNESIA_NOTICE_OPEN_TAG = "<amnesia_notice>"
export const AMNESIA_NOTICE_CLOSE_TAG = "</amnesia_notice>"

export function buildAmnesiaNoticeFragment(input: AmnesiaNoticeInput = {}): ContextFragment {
  const traceLine = input.anchorId
    ? `  <anchor_id>${input.anchorId}</anchor_id>\n  <anchor_kind>${input.anchorKind ?? "narrative"}</anchor_kind>\n`
    : ""
  const kindLabel = (input.anchorKind ?? "narrative").toUpperCase().replace(/_/g, "-")
  const body =
    "\n" +
    traceLine +
    `  COMPACTION NOTICE: Your tool-call history from rounds before the most\n` +
    `  recent anchor has been COMPACTED (kind = ${kindLabel}). The anchor body\n` +
    "  you see is a prose summary; the original tool outputs are NOT in this prompt.\n" +
    "\n" +
    "  However, every pre-anchor tool call IS still recoverable:\n" +
    "  1. Look for the `## TOOL_INDEX` section near the end of the anchor body.\n" +
    "  2. Each row lists (tool_call_id, tool_name, args_brief, status, output_chars).\n" +
    "  3. Call `recall(tool_call_id)` to retrieve the original full output.\n" +
    "\n" +
    "  RULE: If you need to act on, verify, or reason about a prior tool result,\n" +
    "  call `recall(tool_call_id)` instead of trusting the narrative prose alone.\n" +
    "  Re-running a tool that was already run is wasteful — recall it instead.\n" +
    "  If recall returns `unknown_call_id`, the id was misread or its entry was\n" +
    "  truncated; re-execute the original tool as a fallback.\n"
  return {
    id: "amnesia_notice",
    role: "user",
    startMarker: AMNESIA_NOTICE_OPEN_TAG,
    endMarker: AMNESIA_NOTICE_CLOSE_TAG,
    body,
    source: "opencode-only",
  }
}
