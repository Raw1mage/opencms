# BR: Compaction at 05:02 rolled the conversation anchor back one round, replaying an already-answered user message and dropping ~8 minutes of visible progress

- **Date**: 2026-06-14
- **Severity**: high
- **Status**: OBSERVING — fix committed (`0419472f1` fix(compaction): preserve raw tail after narrative anchor, in HEAD) and deployed (HEAD rebuilds this session; binary carries `rawTailProjection`). Mechanism fix covers acceptance #1/#2: newest `fadeout.bTailRounds` completed C rounds are excluded from the narrative anchor and projected back raw via `metadata.rawTailProjection`; `MessageV2.filterCompacted` renders anchor + raw C tail + true post-anchor messages and skips lone pre-anchor unanswered originals, so an already-answered user message can't be replayed as new. Acceptance #3 (explicit post-compaction anchor-messageID monotonicity assertion + anomaly log) was NOT separately added — defense-in-depth follow-up, not blocking, since the rawTail mechanism prevents the rollback at source. Validation: dialog-serializer + compaction-extend-redaction (36 pass) + compaction-replay-deep + claude-refactor.inv0-baseline (42 pass). Observing since 2026-06-15. **Exit → closed/**: a real session crossing a narrative compaction keeps the visible anchor at the latest turn (no `我很疑惑`-style replay), soak clean. **Regress → open**: post-compaction transcript re-surfaces an already-answered user message as newest input.
- **Component**: opencode session runtime — context compaction / anchor selection (NOT docxmcp; filed here per local-first issue policy because it was observed while working in this repo)
- **Reporter**: pkcs12 (live observation during a docxmcp session)

## Summary

A context-compaction event at ~05:02 rewound the visible conversation **anchor** to a prior round. The user message `我很疑惑。docxmcp不是提供了http post上傳，還有http get下載的能力嗎` — which had already been asked and answered at 04:54 — **reappeared at 05:02 as if new**. The assistant, seeing it as the latest turn, **re-answered the same question**, re-deriving a discussion that had already concluded. Meanwhile the ~8 minutes of substantive work between 04:54 and 05:02 (root-cause conclusion, live round-trip proof, direction decision, architecture recon, spec scaffold) **vanished from the visible transcript**.

Critically: the underlying **work was not lost** — only conversation visibility regressed. On-disk artifacts and the event log survived (see Evidence). But the agent had no way to know that from the visible context alone, so it duplicated discussion and risked re-doing or contradicting committed decisions.

## Timeline (reconstructed from session DB via session_recall)

| Time        | Event                                                                                                                                        |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 04:54       | User asks `我很疑惑…http post 上傳…http get 下載…` (FIRST occurrence)                                                                        |
| 04:54–04:55 | Assistant proves both HTTP capabilities work: fresh-token round-trip → HTTP 200 / 27868B / valid Microsoft Word docx downloaded sandbox→host |
| 04:55       | `question` → user picks WebDAV-style session-workdir direction                                                                               |
| 04:57       | `question` → user picks "研究既有 architecture 再決定"                                                                                       |
| 04:59       | Architecture recon: reads `bin/_token_store.py` fully + compose security model                                                               |
| 04:59       | `question` → user **locks decision: "輕量 session-handle facade"**                                                                           |
| 05:00       | `event_record` written (architecture recon)                                                                                                  |
| 05:00–05:01 | Reads HTTP route table; `todowrite` ledger set                                                                                               |
| 05:01       | `specbase_plan_create` → `plans/docxmcp_session-handle-facade/` created                                                                      |
| 05:01–05:02 | `proposal.md` written (6552B, captures user's original wording + decision rationale)                                                         |
| **05:02**   | **A `<prior_context source="narrative">` block appears, immediately followed by the 04:54 user message AGAIN** — anchor rewound              |
| 05:02       | Assistant re-answers `我很疑惑` from scratch (duplicate of 04:54 answer)                                                                     |
| 05:06       | User reports the regression                                                                                                                  |

## Expected behavior

- After compaction, the conversation **anchor** must point at the _latest_ real turn, not a prior one.
- A summarized/compacted prefix may legitimately replace old verbatim turns, but it must **not** re-surface an already-consumed user message as if it were the newest input.
- The post-compaction summary should **preserve the most recent decisions and progress** (decision: lightweight session-handle facade; spec package created; proposal.md written), so the agent does not re-derive or contradict them.

## Actual behavior

- The compaction summary anchored to the `我很疑惑` round (04:54), one round _before_ the latest progress.
- That user message was replayed at 05:02, and the assistant duplicated its earlier answer.
- The entire 04:54→05:02 progress arc (proof, decision, scaffold) was absent from visible context — recoverable only by querying the session DB directly (`session_recall`).

## Evidence

1. **session_recall (240 min window)** shows the duplicate `我很疑惑` user message at both 04:54 and 05:02, with a `<prior_context source="narrative">` block injected immediately before the 05:02 copy.
2. **On-disk survival (work was NOT lost):**
   - `plans/docxmcp_session-handle-facade/.state.json` (281B), `proposal.md` (6552B, mtime 05:02), `README.en.md` (969B)
   - `proposal.md` body contains the user's verbatim requirement and the recorded decision rationale ("輕量 session-handle facade")
   - Event log row in `.specbase/events.sqlite` (summary: "Architecture recon: session-handle facade for docxmcp")
3. **Impact**: assistant re-answered an answered question; without `session_recall` it would have been blind to a locked product decision + an existing draft spec package, risking contradictory rework.

## Hypothesised root cause (needs runtime-side confirmation)

The compaction routine selects the anchor message / summary cut-point **before** the newest turn rather than at-or-after it — i.e. an off-by-one (or stale-cursor) in anchor selection, so the round immediately preceding the summary boundary gets re-presented as live input. The narrative summarizer also did not carry forward the most-recent decisions, compounding the visibility loss.

This is a **conversation-state regression**, distinct from token-budget truncation: nothing was over-length-dropped; the _anchor pointer_ moved backward.

## Suggested investigation (opencode runtime)

1. Trace the compaction anchor-selection logic — confirm whether the cut-point can land before the latest user/assistant turn (off-by-one / stale message cursor).
2. Verify the post-compaction message sequence does not re-emit an already-consumed user message as the newest turn.
3. Ensure the narrative summary captures the _tail_ of progress (latest decisions, created artifacts), not just an early-round snapshot.
4. Add a guard/assertion: post-compaction anchor messageID must be >= pre-compaction latest-consumed messageID.

## Workaround (current session)

- `session_recall` (session DB query) recovered the full 04:54→05:02 trace and confirmed disk artifacts survived. Recommended mitigation for any agent that suspects anchor rollback: query the session DB before re-deriving, and check `plans/` + event log for already-committed decisions.

## Acceptance criteria

1. After a compaction event, the visible anchor points at the genuine latest turn; no already-answered user message is replayed as new.
2. The post-compaction summary preserves the most recent decisions and created artifacts (not just an early-round snapshot).
3. A runtime guard asserts the post-compaction anchor messageID is not earlier than the last consumed turn, with a logged anomaly if violated.

## Fix (2026-06-14)

- Implemented Claude-only C raw-tail preservation for narrative compaction: newest `fadeout.bTailRounds` completed C rounds are excluded from the narrative anchor and projected back raw via `metadata.rawTailProjection`.
- `MessageV2.filterCompacted` now treats anchors with `rawTailProjection` as `anchor + raw C tail + true post-anchor messages`, while skipping lone pre-anchor unanswered originals so replay cannot duplicate the same user intent.
- Follow-up live check: a 05:33 rebind-preemptive compaction at `tokenRatio=0.85` captured the first post-rebind user, replayed it after the anchor, and the next `diag.preLLM` saw `anchor + user` instead of `loop:no_user_after_compaction`.
- Regression coverage: `dialog-serializer.test.ts`, `claude-refactor.inv0-baseline.test.ts`, `compaction-extend-redaction.test.ts`, and `compaction-replay-deep.test.ts`.
- Validation: `bun test packages/opencode/src/session/dialog-serializer.test.ts packages/opencode/src/session/claude-refactor.inv0-baseline.test.ts packages/opencode/src/session/compaction-extend-redaction.test.ts` → 71 pass; `bun test packages/opencode/src/session/compaction-replay-deep.test.ts --timeout 120000` → 7 pass. `bun run verify:typecheck` is blocked by non-TTY; `bun run typecheck` reaches existing `freerun-bridge.ts` nullability errors unrelated to this fix.
