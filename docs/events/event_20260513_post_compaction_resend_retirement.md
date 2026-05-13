# Event 2026-05-13: retire post-compaction runtime-state resend

## 需求

- User requested direct removal of the post-compaction runtime-state resend layer.
- Rationale: the 2026-05-01 `PostCompaction Quick Follow-Up` mechanism was a workaround for older rebind loss; current narrative compaction should rely on structured authorities instead of re-sending selected state as natural language.

## 範圍(IN/OUT)

### IN

- Stop appending todo / in-flight subagent / working-cache state to compaction summary text.
- Stop creating synthetic Continue messages when PostCompaction emits no directive.
- Preserve structured authorities: todo ledger, subagent session state / pending notices, working-cache recall, TOOL_INDEX.

### OUT

- No daemon restart.
- No changes to todo ledger, subagent lifecycle, or working-cache storage semantics.

## 任務清單

- T1. Remove PostCompaction built-in provider output.
- T2. Make summary and continue renderers return empty output.
- T3. Skip synthetic Continue message creation when no non-empty directive exists.
- T4. Update focused tests.
- T5. Run compaction/post-compaction validation.

## Debug Checkpoints

- CP-1: `PostCompaction.gather()` now returns `[]`; `register()` is ignored with a warning.
- CP-2: `buildSummaryAddendum()` and `buildContinueText()` now return empty string for all inputs.
- CP-3: `compactWithSharedContext(auto:true)` and `injectContinueAfterAnchor()` now skip creating synthetic Continue if `continueText` is empty.

## Validation

- Passed: `bun test packages/opencode/src/session/post-compaction.test.ts packages/opencode/src/session/compaction-run.test.ts packages/opencode/src/session/compaction-replay-deep.test.ts packages/opencode/src/session/compaction-replay-integration.test.ts packages/opencode/src/session/compaction-replay-helpers.test.ts`.
- Result: 60 pass / 0 fail.
- Source scan: no remaining actionable `Post-Compaction Quick Follow-Up` / todo / in-flight subagent / working-cache resend strings outside the retired compatibility shell in `post-compaction.ts`.

## Architecture Sync

- Updated behavior is architectural but narrows an existing compaction boundary: compaction now writes only transcript anchors; runtime state authorities stay in todo ledger, subagent lifecycle/pending notice, working-cache recall, and TOOL_INDEX.
- `specs/architecture.md` already describes compaction as the session subsystem boundary and does not document the retired provider table as a canonical architecture component. Architecture Sync: Verified (No doc changes).
