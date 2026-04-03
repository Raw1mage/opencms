# Implementation Spec

## Goal

- Build a complete inventory of the remaining old `cms` missing commits/features, then selectively restore only the user-approved buckets into `main`, while explicitly skipping buckets the user has already rebuilt and forcing a diff-first decision gate before each restore slice.

## Scope

### IN

- Restore the approved branding/browser-tab bucket (`TheSmartAI` title + logo/favicon route).
- Restore or re-land the approved rebind / checkpoint / continuation / session hardening bucket.
- Restore the approved GitHub Copilot reasoning variants bucket.
- Restore the approved `llm packet debug / tests` bucket.
- Restore the approved `Claude Native / claude-provider` bucket.
- Restore the approved `user-init / onboarding / marketplace` bucket.
- Add a full appendix for the remaining `main` vs old-`cms` missing commits (current working estimate: 42/43 scale), mapping each commit to a feature bucket and a decision status (`restore`, `skip`, `already redone`, `needs deeper analysis`).
- Walk the user through the remaining commit buckets/stragglers one by one with explicit decision gates instead of silently dropping them from the plan.
- For every approved bucket, perform a diff-first comparison against current `main` before implementation so already-redone functionality is not blindly overwritten.

### OUT

- Do not blindly cherry-pick all 32~42 missing commits as a batch.
- Do not restore the provider manager / `模型提供者` bucket from old commits because the user said that area was already redone.
- Do not revert current user-authored rewrites just because an older commit existed.
- Do not perform destructive git recovery operations (`reset`, force-history rewrite, bulk branch pointer surgery).
- Do not omit unmatched/miscellaneous missing commits from the inventory just because they do not fit the first round of major feature buckets.

## Assumptions

- Some approved buckets may already be partially or equivalently present in `main`, so implementation must validate real gaps before restoring code.
- Commit-level history is a hint, not the execution source of truth; the actual restore target is the missing product/runtime behavior.
- The user wants decision-aware selective restoration, but does not want any remaining missing commits silently ignored during planning.
- Functional restore must respect commit history and current `main` evolution: restore missing intent/behavior only, never replay an older slice in a way that overwrites a newer implementation.
- Each functional restore must include a supersession review: inspect whether later history revised, partially replaced, or fully superseded the older implementation before deciding what delta is still safe to re-land.
- For all remaining missing commits, prefer ordered reconstruction that respects commit iteration/override history and lands at the newest working shape; direct final-shape reconstruction is allowed only when the final outcome can be derived confidently without losing that history relationship.
- The same newest-workable reconstruction rule also applies to documentation artifacts (`plans/`, `specs/`, `docs/events/`): restore the final readable/usable document state, not an arbitrary older snapshot.

## Stop Gates

- Stop and return to plan mode if a bucket appears already fully reimplemented in a newer shape and restoring the old commit would regress current behavior.
- Stop if a restore slice would require destructive git operations or branch surgery.
- Stop if a bucket splits into multiple unrelated sub-features that need separate approval.
- Stop if current code evidence and old commit behavior disagree in a way that changes product intent.
- Stop and ask for a decision if a commit is inventoried but does not cleanly fit an existing bucket; it must still be surfaced, not dropped.
- Stop if a proposed restore would replace a newer mainline implementation with an older historical shape instead of surgically filling the real gap.
- Stop if later history clearly superseded the old implementation and the remaining gap cannot yet be isolated from the obsolete portions.
- Stop and mark a slice as intentionally deprecated (not restored) when evidence shows the latest `HEAD` solution is superior and reviving the old feature would be a downgrade.

## Critical Files

- `packages/app/index.html`
- `packages/ui/src/components/favicon.tsx`
- `packages/opencode/src/session/compaction.ts`
- `packages/opencode/src/session/prompt.ts`
- `packages/opencode/src/session/llm.ts`
- `packages/opencode/src/session/workflow-runner.ts`
- `packages/opencode/src/plugin/codex-websocket.ts`
- `packages/opencode/src/provider/provider.ts`
- `packages/opencode/src/plugin/claude-native.ts`
- `packages/opencode-claude-provider/`
- `packages/opencode/src/global/index.ts`
- `script/install.ts`
- `docs/events/event_20260401_cms_codex_recovery.md`
- `plans/20260402_commits/tasks.md`
- `plans/20260402_commits/reconstruction-map.md`
- `plans/20260402_commits/branch-strategy.md`

## Structured Execution Phases

- Phase 1: confirm per-bucket diff baselines and write a restore matrix that separates already-redone behavior from truly missing behavior.
- Phase 1A: build a complete missing-commit appendix and map every remaining commit to a bucket/status so no stragglers are lost.
- Phase 1C: decompose R1-R8 into subproblems, dependencies, dedup zones, and keep-deprecated candidates before coding.
- Phase 2: restore the user-approved visible product slice first (branding/browser-tab).
- Phase 3: restore the approved runtime hardening slice (rebind / checkpoint / continuation / subagent lifecycle).
- Phase 4: restore the approved smaller product/runtime buckets (`copilot reasoning variants`, `llm packet debug / tests`).
- Phase 5: restore the approved larger capability buckets (`Claude Native / claude-provider`, `user-init / onboarding / marketplace`) in smaller sub-phases.
- Phase 1B (global reconstruction method): for any remaining commit family, reconstruct toward the latest workable outcome, either by ordered re-landing or by confident direct final-shape recreation when iteration/override evidence is preserved.
- Phase 6: validate, document, and compare final behavior against this plan before declaring completion.

## Validation

- Use per-bucket git/code diff evidence before each restore slice to confirm what is still missing.
- Use the reconstruction problem map as the primary execution contract; commit SHAs are traceability evidence, not the build unit.
- Compare old commit intent against current mainline behavior and commit ancestry before any functional restore; the restore unit is the missing behavior delta, not the old patch wholesale.
- For every functional commit/slice, inspect follow-up history after that commit to see whether the original implementation was revised or overturned before deciding the final restore shape.
- Treat the entire missing-commit set as an iteration chain: the target is always the newest workable result of that chain, not any earlier intermediate snapshot.
- Apply that same target to plans/specs/docs artifacts: the restore target is the newest coherent document state implied by the historical chain.
- When the latest `HEAD` already provides a better replacement, the valid reconstruction outcome may be "keep deprecated" rather than revive the historical feature; this must be recorded with explicit evidence.
- For branding, verify browser title/icon assets from current source files and runtime rendering behavior.
- For session hardening, run targeted tests or focused verification for rebind/checkpoint/continuation flows where available.
- For provider/native and onboarding buckets, validate behavior at the product/runtime level rather than trusting commit presence alone.
- For the `claude` series specifically, validate against complete end-to-end capability restoration (`auth`, `provider registration`, `transport`, `native bridge`, `webapp/provider visibility` where applicable), while still honoring supersession/delta-only restore rules.
- For the `claude` series specifically, validate that the reconstructed result matches the newest workable capability chain rather than a merely earlier working snapshot.
- Record validation evidence and any skipped/deferred sub-slices in `docs/events/event_20260401_cms_codex_recovery.md`.
- Validate restored plan/spec/doc artifacts against the latest intended structure/content, not merely commit presence.

## Handoff

- Build/implementation agent must read this spec first.
- Build/implementation agent must read `proposal.md`, `spec.md`, `design.md`, and `tasks.md` before coding.
- Build/implementation agent must read `reconstruction-map.md` before coding.
- Runtime todo must be materialized from `tasks.md` before coding.
- Every approved bucket must start with diff-first evidence gathering; do not jump straight to cherry-picking or broad code restoration.
- Functional restores must preserve newer mainline behavior; prefer surgical re-landing over historical overwrite when old and new implementations overlap.
- Do not shrink scope opportunistically on any remaining commit family: either reconstruct the ordered chain to the latest workable version or reproduce that latest workable shape directly with explicit evidence.
- If scope changes or a new slice appears, update the same plan root unless a new plan is explicitly user-approved.
