/**
 * ChainInitNotice fragment.
 *
 * Sibling of amnesia-notice: fired once after a chain-identity-breaking
 * event (rebind, rotate, cross-provider switch, daemon-restart-resume,
 * empty-response recovery, backend-failure forced re-send, …).
 *
 * Body composition:
 *   1. Chain-reset framing — tells the AI its server-side reasoning
 *      chain was reset; existing transcript is intact but prior
 *      thought-process is gone.
 *   2. Reason marker — names the event kind so the AI's reasoning can
 *      tag the cause appropriately.
 *   3. Commitment digest — last N mutation-class tool calls so the AI
 *      knows what has already been done.
 *   4. Recovery affordances — recall(call_id) + TOOL_INDEX hint.
 *
 * Policy: `once_after_chain_break`. Marker stored in PendingInjectionStore;
 * consumed by the prompt builder on next outbound (Phase B-C-E rewires).
 *
 * Source: opencode-only (codex CLI upstream has no rebind/rotate/daemon
 * concept and therefore no analogous fragment).
 */

import type { ContextFragment } from "./fragment"
import type { CommitmentDigest } from "../continuation/commitment-digest"
import { COMMITMENT_DIGEST_SENTINEL, renderDigest } from "../continuation/commitment-digest"
import type { ContinuationEventKind } from "../continuation/continuation-event"
import type { PendingContinuationInjection } from "../continuation/pending-injection"

export const CHAIN_INIT_NOTICE_OPEN_TAG = "<chain_init_notice>"
export const CHAIN_INIT_NOTICE_CLOSE_TAG = "</chain_init_notice>"

export interface ChainInitNoticeInput {
  /** Event kind that triggered the break, named to the model. */
  reason: ContinuationEventKind
  /** Commitment digest captured before invalidation. null → sentinel marker. */
  digest: CommitmentDigest | null
  /** Optional anchor id if the break stacked with compaction. */
  anchorId?: string
}

/**
 * Decide whether a chain-init notice should be injected this turn.
 *
 * Reads the pending-injection marker for the session. Returns the
 * marker when `chainInit === true`; the prompt builder then calls
 * `buildChainInitNoticeFragment` with the same payload and consumes
 * the marker once the prompt is dispatched.
 *
 * Returns null when no marker is set or when the marker is amnesia-only
 * (in which case amnesia-notice fires instead, via its own decision
 * helper).
 */
export function decideChainInitInjection(
  pending: PendingContinuationInjection | null,
): PendingContinuationInjection | null {
  if (!pending) return null
  if (!pending.chainInit) return null
  return pending
}

export function buildChainInitNoticeFragment(input: ChainInitNoticeInput): ContextFragment {
  const reasonLabel = humaniseReason(input.reason)
  const anchorLine = input.anchorId ? `  <anchor_id>${input.anchorId}</anchor_id>\n` : ""
  const digestBody = input.digest === null ? COMMITMENT_DIGEST_SENTINEL : renderDigest(input.digest.entries)

  const body =
    "\n" +
    anchorLine +
    `  <reason>${reasonLabel}</reason>\n` +
    "\n" +
    "  CHAIN-RESET NOTICE: Your server-side reasoning chain was just reset.\n" +
    "  The conversation transcript above is intact, but your internal thought-\n" +
    "  process from before this point is NOT carried into this turn. Do not\n" +
    "  assume \"I must have just thought X\" — you didn't, on this chain.\n" +
    "\n" +
    digestBody +
    "\n" +
    "  Recovery affordances available:\n" +
    "  - If the message stream shows an anchor body with a `## TOOL_INDEX`\n" +
    "    section, each row lists (tool_call_id, tool_name, args_brief,\n" +
    "    status, output_chars).\n" +
    "  - Call `recall(tool_call_id)` to retrieve the original full output of\n" +
    "    any prior tool call.\n" +
    "  - If you need information that the commitment digest above does not\n" +
    "    cover and the digest is the sentinel marker, tell the user you\n" +
    "    just experienced a chain reset and need them to confirm current\n" +
    "    state. Do NOT silently re-do mutations to \"verify\" — that's how\n" +
    "    the post-rebind read-loop bug class arises.\n"

  return {
    id: "chain_init_notice",
    role: "user",
    startMarker: CHAIN_INIT_NOTICE_OPEN_TAG,
    endMarker: CHAIN_INIT_NOTICE_CLOSE_TAG,
    body,
    source: "opencode-only",
  }
}

function humaniseReason(kind: ContinuationEventKind): string {
  switch (kind) {
    case "account_switch":
      return "account switched"
    case "account_rotate":
      return "account auto-rotated (quota / 429 / manual)"
    case "provider_switch":
      return "provider switched"
    case "model_switch_same_family":
      return "model switched within same family"
    case "model_switch_cross_family":
      return "model switched cross-family"
    case "session_resume_after_daemon_restart":
      return "session resumed after daemon restart"
    case "empty_response_recovery":
      return "empty-response recovery (chain reset)"
    case "backend_failure_forced_resend":
      return "backend forced full re-send (chain reset)"
    case "compaction_narrative":
    case "compaction_cache_aware":
    case "compaction_stall_recovery":
    case "compaction_preemptive_daemon_restart":
      return "compaction triggered chain reset"
    default:
      return kind
  }
}
