# Event: Plans vs Specs Lifecycle Refactor Planning

## Requirement

- User proposed a repository information architecture where planner work-in-progress artifacts live under `/plans/`.
- User proposed that `/specs/` should represent post-implementation formalized specs, while `specs/architecture.md` remains the long-lived architecture SSOT.
- User requested an audit of required changes across runtime code, `plan.ts`, system prompts, skills, and project rules.

## Scope

### IN

- Define the desired `/plans` vs `/specs` lifecycle model.
- Identify runtime, prompt, skill, template, and documentation surfaces that encode the current `/specs/<plan>/` assumption.
- Produce a planner-ready refactor package for the lifecycle change.

### OUT

- Implementing the refactor in this planning session.
- Bulk-migrating all legacy historical plan folders unless explicitly approved later.
- Rewriting unrelated architecture or workflow behavior outside artifact-location semantics.

## Task List

- [x] Audit current `specs/` root layout and identify misplaced root-level documents.
- [x] Audit code, prompts, skills, templates, and docs for `/specs`-as-plan-root assumptions.
- [x] Decide the authoritative lifecycle transition between `/plans` and `/specs`.
- [x] Rewrite planner artifacts for the lifecycle refactor.
- [x] Validate plan completeness and handoff readiness.

## Conversation Summary

- User observed that `specs/` root should not accumulate many standalone files and should effectively keep only the long-lived architecture document at root.
- User proposed a new semantic split: planning packages belong in `/plans`, and only completed implementation artifacts should become `/specs`.
- Initial audit confirmed the repo currently stores multiple standalone planning/design documents at `specs/` root and many contracts assume dated plan packages live under `/specs/<date_slug>/`.
- The most consequential open design question is when and how a plan package transitions from `/plans` to `/specs`.
- User then clarified the desired lifecycle: active plans stay in `/plans` through execution, commit, and merge; only explicit post-merge user instruction can trigger formalization into `/specs`.
- User also clarified the legacy strategy: inspect old `specs/<date_slug>/` packages for implementation evidence; if implemented, move as formalized specs, otherwise move as plans.
- User chose semantic formalized-spec roots under `specs/<feature-slug>/` instead of preserving dated planner-root naming.

## Debug Checkpoints

### Baseline

- Current runtime path resolution in `packages/opencode/src/session/planner-layout.ts` places repo-local plan roots under `specs/<date_slug>/`.
- `packages/opencode/src/tool/plan.ts`, planner skill content, system prompts, and AGENTS contracts all encode `/specs/<plan>/` as the active planning workspace.

### Instrumentation Plan

- Compare runtime path constructors, mission artifact path storage, template lookup paths, and builder handoff wording.
- Separate references to `specs/architecture.md` (still valid) from references to dated feature plan packages under `specs/<plan>/` (target of refactor).
- Resolve the lifecycle decision before rewriting artifacts so prompts and code share one authoritative model.

### Execution

- Reviewed current `specs/` root inventory.
- Audited runtime code and prompt/skill/doc references for `/specs`, `plan_enter`, `plan_exit`, `tasks.md`, and `implementation-spec.md` assumptions.
- Confirmed direct runtime impact in `planner-layout.ts` and `plan.ts`, plus broad contract impact in templates and project rules.
- Rewrote the planner artifacts to codify the chosen lifecycle, legacy-triage rule, and semantic `specs/<feature-slug>/` naming.
- Rewrote `templates/prompts/SYSTEM.md` and `templates/prompts/constitution.md` so active planner roots are described under `/plans/`, while `specs/architecture.md` remains the architecture SSOT.
- Updated `packages/opencode/src/session/planner-layout.ts` so active planner roots resolve under `/plans/`.
- Updated `packages/opencode/src/tool/plan.ts` so planner templates load from `/etc/opencode/plans` / `templates/plans`, mission roots are validated under `/plans/`, and build-mode handoff wording references the active `/plans` root.
- Rewrote planner/agent-workflow skills and repo/template AGENTS contracts so active plan/build workspaces live under `/plans/`, `specs/architecture.md` remains the architecture SSOT, and `/plans` → `/specs/<feature>` promotion is manual only.
- Validation then exposed remaining test fixtures that still modeled active planner roots under `specs/...`; those fixtures were updated so active-plan test paths now use `/plans/...` consistently.

### Root Cause

- The current system conflates two meanings under `/specs`: active planning workspace and long-lived formal specification storage.
- That conflation causes both repository clutter and ambiguous lifecycle semantics for planner artifacts.
- A second source of ambiguity is legacy dated packages already stored under `/specs`, which need explicit status-based triage rather than blanket migration.

### Validation

- Audit evidence gathered from runtime code, prompt templates, skills, AGENTS files, and existing planner artifacts.
- Planner artifacts were checked for placeholder residue and lifecycle/handoff consistency after the semantic split and legacy-triage rules were added.
- Prompt-template validation confirmed system-level plan-mode instructions now point at `/plans/` rather than `/specs/` for active planning packages.
- Runtime validation confirmed planner root construction and `plan.ts` template/runtime wording now point at `/plans/`.
- Prompt/skill/AGENTS validation confirmed active planning guidance now points at `/plans/` while preserving `specs/architecture.md` as SSOT.
- Follow-up validation confirmed the residual active-plan test fixtures were corrected from `specs/...` to `/plans/...`.
- Architecture Sync: Updated — `specs/architecture.md` now documents `/plans` as the active plan/build workspace, manual `/plans` → `/specs` promotion, and explicit legacy triage rules.

## Verification

- Runtime path construction now resolves active planner roots under `/plans/` in `packages/opencode/src/session/planner-layout.ts`.
- `packages/opencode/src/tool/plan.ts` now loads planner templates from `/etc/opencode/plans` or `templates/plans`, and rejects active mission roots outside `/plans`.
- Prompt, skill, and AGENTS contracts now describe active planning/build under `/plans/` and preserve `specs/architecture.md` as the architecture SSOT.
- Formalized spec naming is documented as semantic per-feature roots (for example `specs/plans-specs-lifecycle`) rather than dated planner roots.
- Legacy dated packages under `/specs/` are documented as explicit status-based triage work, not silent fallback behavior.
- Active-plan test fixtures that previously used `specs/...` were updated to `/plans/...`.

## Remaining

- Legacy dated package triage is documented and fail-fast by contract, but bulk migration of existing historical packages remains deferred and was explicitly out of scope.

## Follow-up: Specs Root Cleanup

- `specs/20260316_kill-switch-plan.md` moved to `plans/20260316_kill-switch-plan/implementation-spec.md`.
- `specs/kill-switch-incident-runbook.md` moved to `docs/runbooks/kill-switch-incident-runbook.md`.
- `specs/kill-switch-deployment-policy.md` moved to `docs/policies/deployment/kill-switch-deployment-policy.md`.
- `specs/codex-protocol-whitepaper.md` moved to `specs/codex-protocol/whitepaper.md`.
- `specs/system-prompt-hooks.md` moved to `specs/system-prompt/hooks.md`.
- `specs/frontend-architecture.md` was merged into `specs/architecture.md` so the `specs/` root converges toward architecture-only.
- Validation confirmed that `specs/` root now contains only `specs/architecture.md`, `plans/20260316_kill-switch-plan/implementation-spec.md` exists, and there are no remaining references to the old `plans/20260316_kill-switch-plan/plan.md` path.

## Follow-up: Telemetry Plan Consolidation

- `specs/telemetry/` is the authoritative telemetry rewrite package and records the bus-first runtime event -> projector -> reducer -> UI-consumer target architecture.
- `specs/telemetry/context-sidebar-optimization/` is the colocated telemetry UI/context-sidebar companion slice under that same semantic root.
- Consolidation target is a semantic formalized spec root: `specs/telemetry/`.
- Consolidation work should preserve the rewrite contract as the primary authority, carry over context-sidebar/card-layout optimization content as a subordinate slice, and update obvious references still pointing at the old dated telemetry roots.
