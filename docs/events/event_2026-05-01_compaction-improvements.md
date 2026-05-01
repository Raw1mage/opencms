# Event: compaction-improvements

## 需求

Start `/home/pkcs12/projects/opencode/specs/compaction-improvements` and execute unless a critical blocker appears.

## 範圍(IN/OUT)

- IN: Promote the existing proposal into an executable plan package, then implement phase-by-phase from `tasks.md`.
- IN: Preserve compaction subsystem SSOT, no silent fallback, and opencode XDG backup discipline.
- OUT: Commit, push, daemon restart, or destructive branch operations unless explicitly requested.

## 任務清單

- Create missing design/planning/modeling artifacts for `specs/compaction-improvements/`.
- Back up XDG whitelist config before implementation/test commands.
- Execute Phase A first: provider-switched fallback, rebind token refresh, no-user boundary guard coverage.

## Debug Checkpoints

- Baseline: spec existed only as `proposal.md` with `.state.json.state = proposed`; `tasks.md` and `handoff.md` were absent.
- Instrumentation Plan: use focused reads of compaction/session files and existing tests before code edits; record command evidence here.

## Decisions

- DD-E1: Treat missing `tasks.md` as a planning blocker, not an implementation blocker; fill required artifacts before touching code.
- DD-E2: Start with Phase A edge cleanup because it is lowest risk and reduces failure modes before predictive trigger changes.
- DD-E3: Build paused after Phase C 3.1 because `proposal.md` still carried Open Questions Q1-Q26. These are now resolved in `specs/compaction-improvements/design.md` DD-6 and its Open Question Resolution Matrix; remaining Phase C/D/E work must follow those decisions.

## Verification

- Plan validation/promotions: `proposed -> designed -> planned -> implementing` completed after artifact format fixes.
- Task 1.1 validation: `bun test packages/opencode/test/session/compaction.test.ts` passed (25 pass, 0 fail).
- Task 1.2 validation: `bun test packages/opencode/test/session/compaction.test.ts packages/opencode/test/session/prompt-special-chars.test.ts packages/opencode/test/session/prompt-variant.test.ts packages/opencode/test/session/prompt-account-routing.test.ts packages/opencode/test/session/prompt-missing-file.test.ts` passed (29 pass, 0 fail).
- Task 1.3 validation: same Phase A focused suite passed after guard test addition (30 pass, 0 fail).
- Task 2.1 validation: `bun test packages/opencode/test/config/tweaks.test.ts` passed (32 pass, 0 fail).
- Task 2.2 validation: `bun test packages/opencode/test/session/prompt-account-routing.test.ts packages/opencode/test/config/tweaks.test.ts` passed (35 pass, 0 fail).
- Task 2.3 validation: same focused budget suite passed after self-heal nudge coverage (36 pass, 0 fail).
- Architecture Sync: Updated `specs/architecture.md` Compaction Subsystem cost-chain / runloop guard notes for Phase A.
- XDG Backup: `/home/pkcs12/.config/opencode.bak-20260501-0131-compaction-improvements` (whitelist snapshot only; manual restore only if requested).
- Task 3.1 validation: trigger inventory contract and predicate evaluation tests passed before design-gate pause; DD-6 now captures Q1-Q26 decisions required for 3.2+.
- Plan validation after DD-6: `bun run /home/pkcs12/projects/skills/plan-builder/scripts/plan-validate.ts specs/compaction-improvements` passed for state=implementing (13 artifacts).
- Plan sync after DD-6: warned on unrelated beta diff paths `packages/opencode/src/session/resolve-tools.ts` and `packages/opencode/src/tool/tool-loader.ts`; no compaction spec drift action required for DD-6.
- Main isolation check: `/home/pkcs12/projects/opencode` status contains only pre-existing `templates/skills` and SYSTEM backup files; no compaction files in main.
- Task 3.2 validation: `bun test packages/opencode/test/session/compaction.test.ts packages/opencode/test/config/tweaks.test.ts packages/opencode/test/session/prompt-account-routing.test.ts` passed (64 pass, 0 fail) after adding predicted cache-miss and stall-recovery predicate coverage.
- Task 3.3 validation: same focused suite passed (65 pass, 0 fail) after adding provider-aware `resolveKindChain`; codex subscription is inferred from codex OAuth cost-zero model evidence, while `openai` remains fail-closed/non-subscription.
- Task 3.4 validation: `bun test packages/opencode-codex-provider/src/provider.test.ts packages/opencode/test/session/compaction.test.ts` passed (32 pass, 0 fail). `packages/opencode-codex-provider/src/provider.ts` now exposes a tested Mode 1 `/responses` body builder that always emits `context_management: [{ type: "compaction", compact_threshold }]`; Phase 3.3 chain priority drives standalone kind-4 server compaction for high-context codex subscription sessions.

- Task 4.1 validation: `bun test packages/opencode/src/session/message-v2.attachment-ref.test.ts packages/opencode/src/session/storage/legacy.test.ts packages/opencode/src/session/storage/sqlite.test.ts packages/opencode/src/session/storage/router.test.ts` passed (45 pass, 0 fail). Added `attachment_ref` part schema plus session-scoped Legacy/SQLite/Router attachment blob contract with SQLite v2 migration.
- Task 4.2 validation: `bun test packages/opencode/src/session/user-message-parts.test.ts packages/opencode/src/session/message-v2.attachment-ref.test.ts packages/opencode/src/session/storage/legacy.test.ts packages/opencode/src/session/storage/sqlite.test.ts packages/opencode/src/session/storage/router.test.ts packages/opencode/test/config/tweaks.test.ts` passed (82 pass, 0 fail). Oversized user-message file/data attachments now route through session-scoped attachment blob storage as `attachment_ref` parts with configurable boundary thresholds; storage failures propagate instead of falling back to raw content.
- Task 4.3 validation: `bun test packages/opencode/src/tool/task.subagent-result.test.ts packages/opencode/src/session/user-message-parts.test.ts packages/opencode/src/session/message-v2.attachment-ref.test.ts packages/opencode/src/session/storage/legacy.test.ts packages/opencode/src/session/storage/sqlite.test.ts packages/opencode/src/session/storage/router.test.ts` passed (53 pass, 0 fail). Oversized subagent results now flow through `TaskCompletedEvent.result` and pending notices as inline text or session-scoped `attachment_ref` metadata; storage failures propagate instead of raw fallback.
- Task 4.4 validation: `bun test packages/opencode/src/tool/attachment.test.ts packages/opencode/src/tool/task.subagent-result.test.ts packages/opencode/src/session/user-message-parts.test.ts packages/opencode/src/session/message-v2.attachment-ref.test.ts packages/opencode/src/session/storage/legacy.test.ts packages/opencode/src/session/storage/sqlite.test.ts packages/opencode/src/session/storage/router.test.ts` passed (57 pass, 0 fail). Added registered `attachment` tool for session-scoped `attachment_ref` digest/drilldown; text/task-result refs return bounded previews and metadata, missing refs fail explicitly, and image/vision queries fail with explicit capability errors without model fallback.
- Task 5.1 validation: `bun test packages/opencode/src/session/compaction-telemetry.test.ts packages/opencode/src/tool/attachment.test.ts packages/opencode/src/tool/task.subagent-result.test.ts packages/opencode/src/session/user-message-parts.test.ts packages/opencode/test/session/compaction.test.ts packages/opencode/test/session/prompt-account-routing.test.ts` passed (48 pass, 0 fail). Added bounded debug telemetry for compaction predicate outcomes, provider-aware kind chains, context-budget surfacing, and big-content boundary routing without raw attachment or prompt content.
- Task 5.2 validation: `bun test packages/opencode/test/session/compaction.test.ts packages/opencode/src/session/compaction-telemetry.test.ts packages/opencode/test/session/prompt-account-routing.test.ts packages/opencode/test/config/tweaks.test.ts packages/opencode/src/session/user-message-parts.test.ts packages/opencode/src/tool/task.subagent-result.test.ts packages/opencode/src/tool/attachment.test.ts packages/opencode/src/session/message-v2.attachment-ref.test.ts packages/opencode/src/session/storage/legacy.test.ts packages/opencode/src/session/storage/sqlite.test.ts packages/opencode/src/session/storage/router.test.ts packages/opencode-codex-provider/src/provider.test.ts` passed (130 pass, 0 fail). No regressions found in the focused compaction/session validation suite.
- Task 5.3 validation: `specs/architecture.md` Compaction Subsystem now documents Phase D/E attachment references, bounded drilldown, and raw-content-safe telemetry. `tasks.md` shows all Phase E tasks complete.
- Architecture Sync: Updated `specs/architecture.md` Compaction Subsystem Phase D/E implementation notes.
- Final gate blocker resolved: `plan-builder/scripts/plan-validate.ts` was fixed to validate `tasks.md` according to lifecycle state. `verified` now accepts fully checked task lists and rejects remaining unchecked work.
- Separate issue observed but not fixed in 5.2: `system-manager_read_subsession`/CMS transcript tooling must read DB-backed session storage instead of legacy `messages/` directories; no focused compaction/session test failed on this, so it remains out of scope for this task.
- Beta realignment after main hotfix commit `b9d0b9b`: `beta/compaction-improvements` was rebased onto main; obsolete beta commit `114f958d3` was skipped because main already superseded its todo priority/id defaults. The compaction feature stash was reapplied on the main hotfix base and conflict resolution treated main as authority for empty-response compaction, post-compaction follow-up, disk-terminal subagent completion, and account preflight semantics.
- Realignment validation: `bun test --timeout 30000 packages/opencode/test/session/prompt-account-routing.test.ts packages/opencode/src/session/compaction*.test.ts packages/opencode/src/session/*attachment*.test.ts packages/opencode/src/session/user-message-*.test.ts` passed (47 pass, 0 fail). Updated tests pin the post-hotfix contract: parent empty-response recovery routes through `SessionCompaction.run({ observed: "empty-response" })` instead of synthetic retry nudge, and provider-switched compaction remains local-only (`narrative`, `replay-tail`) with no paid fallback kinds.
- Realignment plan-sync: `plan-sync` warned because the beta branch base moved from `fef4c6b` to main `b9d0b9b`, so diff scanning includes unrelated main hotfix paths (`system-manager`, UI scroll, daemon/session hotfixes). These are base-authority changes already documented outside this compaction spec; no new compaction scope expansion is required.
- Second beta realignment after main commits `4d9ad2e80` and `4953bef3e`: beta was fast-forwarded to main, a new rollback stash `pre-main-realign-2 compaction-improvements 2026-05-01` was kept, and the compaction feature stash was reapplied. The only conflict was `packages/opencode/src/session/compaction.ts`; resolution keeps main's early `CompactionStarted(mode: "auto")` UI event at `run()` entry and beta's provider-aware kind-chain/telemetry logic.
- Second realignment validation: `git diff --check` passed and `bun test --timeout 30000 packages/opencode/test/session/prompt-account-routing.test.ts packages/opencode/src/session/compaction*.test.ts packages/opencode/src/session/*attachment*.test.ts packages/opencode/src/session/user-message-*.test.ts` passed (47 pass, 0 fail).
- Test-branch fetch-back: created physical branch `test/compaction-improvements` in the main repo via worktree `/home/pkcs12/projects/opencode-worktrees/test-compaction-improvements`, cherry-picked beta commit `f891764aa` as `c9bf4b57e`, and did not merge into `main`.
- Test-branch validation: after installing dependencies in the isolated test worktree, `bun test --timeout 30000 packages/opencode/test/session/prompt-account-routing.test.ts packages/opencode/src/session/compaction*.test.ts packages/opencode/src/session/*attachment*.test.ts packages/opencode/src/session/user-message-*.test.ts` passed (47 pass, 0 fail); `plan-validate` passed for `state=verified`.

## Phase Summary

### Phase 1 — Edge cleanup foundation

- Done: 1.1, 1.2, 1.3.
- Key decisions: provider-switched now has local replay-tail fallback; rebind token refresh now also occurs for no-anchor / unsafe-boundary attempts; no-user runloop boundary stops safely instead of throwing.
- Validation: Phase A focused suite `bun test packages/opencode/test/session/compaction.test.ts packages/opencode/test/session/prompt-account-routing.test.ts packages/opencode/test/session/prompt-special-chars.test.ts packages/opencode/test/session/prompt-variant.test.ts packages/opencode/test/session/prompt-missing-file.test.ts` — 30 pass, 0 fail.
- Drift: plan-sync clean after 1.2; final phase sync pending immediately after this summary.
- Remaining: Phase B context budget surfacing.

### Phase 2 — Context budget surfacing

- Done: 2.1, 2.2, 2.3.
- Key decisions: budget status thresholds live in `tweaks.cfg`; model-message assembly appends `<context_budget>` only to the current session's latest user message; self-heal nudge uses the most recent non-empty server-confirmed assistant usage snapshot.
- Validation: `bun test packages/opencode/test/session/prompt-account-routing.test.ts packages/opencode/test/config/tweaks.test.ts` — 36 pass, 0 fail.
- Drift: plan-sync clean after 2.2; final phase sync pending immediately after this summary.
- Remaining: Phase C trigger inventory and codex routing.

### Phase 3 — Trigger inventory and codex routing

- Done: 3.1, 3.2, 3.3, 3.4.
- Key decisions: trigger precedence is explicit in `TRIGGER_INVENTORY`; cache-loss and stall-recovery predicates are gated by context ratio and no-Continue semantics; high-context codex OAuth subscription sessions prioritize low-cost server compaction; regular codex `/responses` requests carry Mode 1 `context_management` shape via a tested body builder.
- Validation: `bun test packages/opencode/test/session/compaction.test.ts packages/opencode/test/config/tweaks.test.ts packages/opencode/test/session/prompt-account-routing.test.ts` — 65 pass, 0 fail for 3.3; `bun test packages/opencode-codex-provider/src/provider.test.ts packages/opencode/test/session/compaction.test.ts` — 32 pass, 0 fail for 3.4.
- Drift: final phase sync pending immediately after this summary.
- Remaining: Phase D big content boundary handling.

### Phase 4 — Big content boundary handling

- Done: 4.1, 4.2, 4.3, 4.4.
- Key decisions: oversized user attachments and subagent results are stored in session-scoped attachment blobs; prompt/tool surfaces receive bounded `attachment_ref` previews/metadata; the query tool fails explicitly for missing refs and image vision capability gaps instead of silently choosing a fallback model.
- Validation: `bun test packages/opencode/src/tool/attachment.test.ts packages/opencode/src/tool/task.subagent-result.test.ts packages/opencode/src/session/user-message-parts.test.ts packages/opencode/src/session/message-v2.attachment-ref.test.ts packages/opencode/src/session/storage/legacy.test.ts packages/opencode/src/session/storage/sqlite.test.ts packages/opencode/src/session/storage/router.test.ts` — 57 pass, 0 fail.
- Remaining: Phase E telemetry, validation, and docs.

### Phase 5 — Telemetry, validation, and docs

- Done: 5.1, 5.2, 5.3.
- Key decisions: telemetry is emitted as bounded debug payloads through existing checkpoints, never as a parallel bus or raw prompt/blob dump; final documentation records Phase D/E contracts in `specs/architecture.md`. After realigning beta onto main hotfix, main hotfix behavior is authoritative where contracts overlap.
- Validation: focused compaction/session suite passed — 130 pass, 0 fail before realignment; first and second post-realignment focused suites passed — 47 pass, 0 fail each; `plan-promote --to verified`, `plan-validate`, and `plan-sync` all passed after the validator fix.
- Drift: final pre-realignment plan-sync was clean; post-realignment plan-sync warned on unrelated main hotfix/base paths after rebasing onto `b9d0b9b`, recorded above as non-compaction drift.
- Remaining: none for implementation; test-branch review/merge remains outside this request unless explicitly requested.

## Remaining

- All implementation tasks are complete. Spec state is `verified`. Test branch `test/compaction-improvements` contains the fetch-back commit and is ready for review.
