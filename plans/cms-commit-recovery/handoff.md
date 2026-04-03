# Handoff

## Execution Contract

- Build/implementation agent must read `implementation-spec.md` first.
- Build/implementation agent must read `proposal.md`, `spec.md`, `design.md`, and `tasks.md` before coding.
- Runtime todo must be materialized from `tasks.md` before execution continues.
- Execution is latest-HEAD reconstruction first: do not treat missing commit history as permission to replay raw patches.
- Every approved bucket begins with diff-first evidence gathering before code changes.

## Required Reads

- `proposal.md`
- `spec.md`
- `design.md`
- `implementation-spec.md`
- `tasks.md`
- `reconstruction-map.md`
- `branch-strategy.md`
- `docs/events/event_20260401_cms_codex_recovery.md`

## Current State

- Beta authority fields:
  - `mainRepo`: `/home/pkcs12/projects/opencode`
  - `mainWorktree`: `/home/pkcs12/projects/opencode`
  - `baseBranch`: `main`
  - `implementationRepo`: `/home/pkcs12/projects/opencode`
  - `implementationWorktree`: `/home/pkcs12/projects/opencode-worktrees/beta-restore-missing-commits`
  - `implementationBranch`: `beta/restore-missing-commits`
  - `docsWriteRepo`: `/home/pkcs12/projects/opencode`
  - Admission: passed
  - Branch origin: `beta/restore-missing-commits` created from `main` at `58d217116c808014ba5a5aba2d22ebddb6c73a9a`
- User-approved restore buckets:
  - branding/browser-tab
  - rebind / checkpoint / continuation / session hardening
  - GitHub Copilot reasoning variants
  - `llm packet debug / tests`
  - `Claude Native / claude-provider`
  - `user-init / onboarding / marketplace`
- User-skipped bucket:
  - provider manager / `模型提供者` (already redone by user)
- Wave execution status:
  - Wave 0: complete
  - Wave 1: complete
  - Wave 2: complete
  - Wave 3: complete
  - Wave 4: complete
  - Wave 5: complete (documentation/final-state sync)
- Execution must preserve the user's rebuild work and only restore behavior still missing in current `main`.
- Execution must translate historical commits into reconstruction slices that make sense on current `HEAD`.
- Execution may conclude "do not restore / keep deprecated" for a historical slice when current `HEAD` is demonstrably better, but only with explicit evidence.
- Build execution must use the R1-R8 reconstruction problem map and its subproblems as the main unit of work, not individual commit SHAs.
- Note: `mainWorktree` is currently dirty (`docs/events/event_20260401_cms_codex_recovery.md`, `plans/20260402_commits/`); this does not block beta execution, but it is a fetch-back / finalize blocker until explicitly handled.
- Current stop point: implementation/documentation waves are finished; do **not** fetch-back, checktest, finalize, merge, or cleanup until the dirty `mainWorktree` blocker is intentionally handled and the operator explicitly approves the next workflow step.

## Stop Gates In Force

- Stop if a bucket is already fully reimplemented in a newer shape.
- Stop if a restore slice would overwrite user-redone behavior.
- Stop if a bucket decomposes into a new approval-worthy sub-scope.
- Stop for any destructive git requirement or history surgery request.
- Stop if the worker starts replaying old patches without first expressing the target newest workable end state.

## Build Entry Recommendation

- Start with `tasks.md` section 1 and build the reconstruction problem map + restore matrix first.
- Use `reconstruction-map.md` wave order as the default branch/test-branch progression unless analysis gates force replanning.
- Do not start code changes until the subproblem/dependency layer is explicit enough to avoid replaying mixed or obsolete slices.
- Restore branding first because it is a user-confirmed visible regression.
- Treat `Claude Native / claude-provider` as a larger later-phase bucket and slice it before coding broadly.

## Execution-Ready Checklist

- [x] Implementation spec is complete
- [x] Companion artifacts are aligned
- [x] Validation plan is explicit
- [x] Runtime todo seed is present in `tasks.md`

## Completion / Retrospective Contract

- Review implementation against the proposal's effective requirement description.
- Report reconstruction-problem coverage: rebuilt, already-present, skipped, deferred, superseded, or directly synthesized on latest `HEAD`.
- Report reconstruction-problem coverage: rebuilt, already-present, skipped, deferred, superseded, directly synthesized on latest `HEAD`, or intentionally kept deprecated.
- Sync `docs/events/event_20260401_cms_codex_recovery.md` with evidence and architecture-sync status.
- Before any future fetch-back/finalize discussion, restate beta authority fields again and report the dirty-file blocker in `mainWorktree`.
- Do not expose raw internal chain-of-thought; expose only auditable conclusions and evidence.
