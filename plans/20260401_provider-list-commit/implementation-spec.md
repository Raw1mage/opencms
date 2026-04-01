# Implementation Spec

## Goal

- Restore the highest-value functionality still missing from `recovery/cms-codex-20260401-183212` after the 2026-04-01 `cms` drift by refactoring each remaining capability slice back in one at a time instead of merging historical branches.

## Scope

### IN

- Refactor the remaining high-value recovery slices back into the active `recovery` branch one slice at a time through beta workflow execution surfaces.
- Slice 1: Claude Native / `claude-provider` capability chain, re-planned into smaller executable sub-stages.
- Slice 2: runtime/context optimization hardening.
- Slice 3: rebind / continuation / session hardening.
- Slice 4: webapp provider manager completion work that remains after the restored `模型提供者` UI patch.
- Per-slice validation, event logging, and architecture sync verification.

### OUT

- Direct merge, hard reset, or history rewrite from stale `cms`, `beta/*`, or `test/*` branches.
- Bulk cherry-pick of the full `3ab872842` lost range.
- Low-priority recovery of docs, plans, templates, refs, submodule, branding, or website deltas.
- Automatic promotion of this plan into `/specs/`.

## Assumptions

- The current `recovery` branch already contains most 4/1 critical-path behavior, including the `模型提供者` UI patch and `claude-cli` provider registration fix.
- Remaining recovery work is safest when grouped by capability chain rather than original commit order.
- Some original commits cannot be replayed verbatim because they depend on stale execution surfaces or intermediate ref states; functional refactor is the correct recovery strategy.
- Build execution for all remaining recovery slices must run through the beta workflow, with mainline authority and implementation surface explicitly separated.
- The Claude Native chain is too large for a single first-pass recovery slice and must be decomposed into scaffold/bridge/wiring/activation sub-stages before coding resumes.
- The minimum Claude Native auth-init path has now been restored and committed on `beta/provider-list-commit` as `2a293ce5e`; remaining native lifecycle/full-transport work is deferred rather than blocking the next slice.

## Stop Gates

- Stop if a target slice depends on ambiguous historical behavior that cannot be reconstructed from current code, git evidence, and surviving refs.
- Stop if a slice would require destructive git operations, broad branch merges, or authority decisions that conflict with the rewritten beta-workflow contract.
- Stop and re-enter planning if a slice expands beyond its declared files/contracts or reveals a larger architecture change than expected.
- Stop if `mainRepo`, `mainWorktree`, `baseBranch`, `implementationRepo`, `implementationWorktree`, `implementationBranch`, or `docsWriteRepo` are not explicit and mutually consistent before build execution.
- Stop for user approval before any commit, push, or destructive branch/worktree cleanup.

## Critical Files

- `packages/opencode-claude-provider/**`
- `packages/opencode/src/provider/**`
- `packages/opencode/src/session/**`
- `packages/opencode/src/tool/**`
- `packages/opencode/src/auth/**`
- `packages/app/src/components/dialog-select-provider.tsx`
- `packages/app/src/components/dialog-custom-provider.tsx`
- `packages/app/src/hooks/use-providers.ts`
- `packages/app/src/i18n/zht.ts`
- `docs/events/event_20260401_cms_codex_recovery.md`
- `specs/architecture.md`

## Structured Execution Phases

- Phase 1 — Bootstrap the beta workflow execution surface from `recovery/cms-codex-20260401-183212` before any code-bearing slice starts.
- Phase 2 — Recover the Claude Native source scaffold and bounded package surface without enabling the full native path yet.
- Phase 3 — Recover the Claude Native auth/account bridge and loader wiring as explicit intermediate slices.
- Phase 4 — Activate and validate the minimum viable Claude Native / `claude-provider` path only after scaffold and bridge slices are in place.
- Phase 5 — Recover runtime/context optimization hardening slices, starting with lazy tool loading / adaptive auto-load, then small-context compaction truncation, then toolcall schema/error-recovery guidance.
- Phase 6 — Recover rebind / continuation / session hardening slices, starting with rebind checkpoint durability + safe checkpoint injection before revisiting any remaining continuation/session leftovers.
- Phase 7 — Recover the remaining provider manager product slice, starting with webapp model-manager provider visibility/favorites semantics before any later dialog reopen cleanup.
- Phase 8 — Run focused provider/webapp validation for the completed `8.2a` slice, keep `8.2b` deferred unless new reopen-geometry evidence appears, and record evidence.
- Phase 9 — Produce retrospective closure artifacts: compare implementation against the effective requirement description, summarize restored vs deferred behavior, and assemble the validation checklist.
- Phase 10 — Enter the approval-gated finalize path: prepare the fetch-back/finalize recommendation, stop for user approval, and only then clean up disposable `beta/*` surfaces.

## Validation

- For each slice, run the narrowest relevant tests/typechecks first, then broader validation only if the slice changes shared runtime surfaces.
- Re-run targeted provider/webapp validation after provider-related slices; re-run targeted runtime/session validation after session/tooling slices.
- Use git evidence to confirm the intended capability is functionally restored even when the original commit SHA is not reintroduced into ancestry.
- Record per-slice evidence in `docs/events/event_20260401_cms_codex_recovery.md`.
- Verify `specs/architecture.md` changed only when boundaries/data-flow/state-machine truths changed; otherwise record `Architecture Sync: Verified (No doc changes)`.
- Current build entry is `8.3` focused provider/webapp validation for the completed `8.2a` slice; `8.2b` dialog reopen geometry cleanup stays deferred by default and should resume only with new reopen-defect evidence.
- Plan completion requires `8.3`, `9.2`, and `9.3` evidence before the finalize recommendation is considered ready for user approval.

## Handoff

- Build/implementation agent must read this spec first.
- Build/implementation agent must read `proposal.md`, `spec.md`, `design.md`, and `tasks.md` before coding.
- Build/implementation agent must materialize runtime todo from `tasks.md` before coding.
- Build/implementation agent must implement only one recovery slice at a time in value order unless planner artifacts are explicitly updated.
- Build/implementation agent must treat old commits as evidence sources, not as merge authority.
- Build/implementation agent must execute through beta workflow only: code changes happen on the beta implementation surface, while `/plans`, `docs/events`, and `specs/architecture.md` stay anchored to the authoritative main repo/worktree.
- Build/implementation agent must restate the full beta authority tuple before coding, validation, fetch-back, or finalize.
- Conversation memory is supporting context only, not the execution source of truth.
- If scope changes or a new slice appears, update the same plan root unless a new plan is explicitly user-approved.
- At completion time, review implementation against the proposal's effective requirement description.
