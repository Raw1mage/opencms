# Event: Beta Tool Plan Exit Build Loop Integration Planning

**Date**: 2026-03-21
**Status**: In Progress

---

## Requirement

User requested that the beta-tool workflow stop being an MCP-only side path and instead integrate directly into the existing builder workflow, so that when `plan_exit` asks whether to start build mode and the answer is yes, the system automatically follows the beta development flow.

The requirement was later clarified with hard constraints:

1. Do **not** break existing builder functionality; optimize the current hardcoded builder instead of replacing it.
2. Keep the change focused on process optimization so builder (a) understands beta development flow and (b) uses related deterministic tools/primitives to reduce AI dependence for routine work.
3. Final UX target: once the user enters build mode, they should no longer need to keep prompting for routine branch checkout, commit, push, pull, and related orchestration details; builder should manage those defaults on a safe beta branch/worktree and return a testable branch to the main repo before merge approval.
4. Final steady state: users should no longer need `mcp dev-tool / beta-tool` in normal workflow because the capability is built into the hardcoded builder.
5. `plan_enter` must not blindly overwrite existing plan roots; overwrite protection is now an explicit requirement in this same change set.
6. Branch transitions must use clean committed heads: builder must not open beta from dirty mainline and must not syncback dirty uncommitted beta work.
7. Planner/spec/event documents must always be written to the authoritative main repo/worktree; planning may be triggered while working from beta, but document storage must not fork into beta worktrees because that causes version bloom.
8. Builder design must include common state-remediation flows such as detecting when main has advanced after beta bootstrap and preparing approval-gated rebase/remediation steps instead of only handling the happy path.

## Scope

### IN

- Define how the existing builder becomes beta-aware.
- Define how current beta-tool logic is internalized into builder-native deterministic behavior.
- Define beta bootstrap, commit/push/pull defaults, syncback-based validation, and merge-preflight flow inside the current builder lifecycle.
- Add regression protection for existing non-beta builder behavior.
- Add migration/deprecation path for beta/dev MCP.
- Update active plan artifacts and architecture/event documentation for this workflow contract.

### OUT

- Replacing builder with a new execution system.
- Automatic merge / cleanup without explicit approval.
- Silent fallback for branch naming, runtime policy, or merge decisions.
- Keeping beta/dev MCP as the intended steady-state control plane.

## Task List

- Map existing builder entry/runtime surfaces.
- Define compatibility-preserving beta-aware mission and workflow contract.
- Update active `/plans/20260321_beta-tool/` package to reflect conservative builder optimization.
- Sync event and architecture documentation if long-lived module boundaries change.

## Dialogue Summary

- Initial request asked to combine beta-tool and `plan_exit` build mode into a one-line workflow.
- Follow-up clarified the desired lifecycle: beta branch/worktree creation -> implementation -> syncback to main repo for testing -> merge after success.
- Inspection showed build mode already has hardcoded control surfaces: `plan_exit`, session mission metadata, workflow-runner, and build runner prompt contract.
- User then clarified the preferred strategy: if builder already exists, optimize it so it follows beta-tool workflow rather than inventing a new builder.
- User emphasized backward compatibility and reducing AI dependence for routine git/worktree/runtime operations.
- User further clarified the final UX target: routine checkout/commit/push/pull details should become builder-owned defaults so entering build is enough.
- User finally clarified the end state: `mcp dev-tool / beta-tool` should no longer be needed once builder-native workflow is complete.
- User additionally clarified a planner-location invariant: planning may be triggered from any current worktree, but long-lived planner/spec/event documents must always be written to the main repo/worktree, never stored in beta worktrees.
- User additionally clarified that builder design must handle common branch-drift/remediation cases, especially when main advances after beta bootstrap and rebase onto the new mainline becomes necessary.

## Debug / Planning Checkpoints

### Baseline

- `packages/opencode/src/tool/plan.ts` owns build entry.
- `packages/opencode/src/session/index.ts` mission/workflow schema and `packages/opencode/src/session/workflow-runner.ts` continuation runtime form the builder control plane.
- `packages/opencode/src/session/prompt/runner.txt` provides a generic build-mode execution contract.
- `packages/mcp/branch-cicd` already implements beta workflow logic but currently as a separate surface.

### Instrumentation / Evidence Plan

- Read builder entry/runtime files and identify narrow insertion points.
- Keep active planner artifacts aligned with the conservative optimization strategy.
- Delay architecture rewrite until implementation confirms final long-lived module boundaries.

### Evidence Gathered

- `plan_exit` validates planner artifacts, materializes todos, sets mission metadata, and injects a synthetic build-mode handoff.
- Mission schema now carries beta-aware lifecycle contract via `mission.beta`.
- Workflow runner now controls bootstrap-adjacent context carryover, validation syncback preparation/execution, and finalize preflight metadata for build mode.
- Existing beta-tool logic was incrementally internalized into builder-owned behavior through shared primitives and builder-facing helpers.
- `PlanEnterTool` originally checked only whether `implementation-spec.md` exists before writing all templates, so a partial or damaged root could be overwritten too aggressively.

### Root Decision

- Optimize the existing builder control plane instead of replacing it.
- Internalize deterministic beta primitives/tooling so routine orchestration shifts away from repeated AI reasoning.
- Preserve non-beta builder compatibility and keep merge approval-gated.
- Include routine remote operations (push/pull) in the builder-owned flow where policy allows, so users do not need to keep prompting for them.
- Treat beta/dev MCP as migration scaffolding only, then deprecate/remove it once builder-native workflow is validated.
- Add `plan_enter` planner-root integrity checks so existing curated artifacts are reused or blocked instead of silently overwritten.
- Enforce clean-head branch invariants so mainline dirtiness blocks bootstrap and uncommitted beta work blocks syncback.
- Enforce main-repo-only planner document storage so beta worktrees never become the write location for `/plans`, `/specs`, or `docs/events`.
- Treat branch drift as a first-class builder state that should surface remediation preflight and approval, not a manual out-of-band surprise.

## Key Decisions

1. Existing builder remains the backbone.
2. Builder becomes beta-aware through narrow flow changes.
3. Deterministic beta primitives are preferred over prompt-only orchestration.
4. Non-beta compatibility is a first-class validation target.
5. Merge/cleanup remain explicit approval-gated operations.
6. Routine commit/push/pull/checkout should become builder-owned defaults where policy permits.
7. `mcp dev-tool / beta-tool` is not the target end state and should be deprecated/removed after migration.
8. Bootstrap/syncback boundaries must be commit-head based, not dirty-tree based.
9. Planning/spec/event document storage must remain anchored to the main repo/worktree.
10. Rebase/remediation after mainline drift should default to detect + ask approval, not silent auto-rebase.

## Implementation Progress

- Completed planner-root guard in `packages/opencode/src/tool/plan.ts`:
  - `plan_enter` now inspects existing dated planner roots before materializing templates.
  - Empty and template-only roots are allowed and repaired.
  - Partial or curated non-template roots now fail fast instead of being overwritten.
- Added regression coverage in `packages/opencode/test/session/planner-reactivation.test.ts` for:
  - rejecting overwrite of partial real planner content;
  - repairing template-only planner roots.
- Added minimal builder beta mission metadata plumbing:
  - `packages/opencode/src/session/index.ts` adds `MissionBetaContext` and optional `mission.beta`.
  - `packages/opencode/src/tool/plan.ts` derives beta mission context from approved plan artifacts during `plan_exit`.
  - `packages/opencode/src/session/workflow-runner.ts` carries beta metadata into runner mission metadata.
  - `packages/opencode/src/session/mission-consumption.ts` preserves beta mission metadata during approved-mission consumption.
  - `packages/opencode/src/session/mission-consumption.test.ts` covers beta metadata preservation.
- Completed builder-native beta bootstrap internalization and `plan_exit` wiring:
  - `packages/opencode/src/session/beta-bootstrap.ts` now owns builder-facing beta bootstrap, syncback preparation, syncback execution, and finalize preflight preparation.
  - The helper reuses deterministic branch/worktree/runtime primitives from `packages/mcp/branch-cicd/src/project-policy.ts` and project context resolution from `packages/mcp/branch-cicd/src/context.ts`.
  - `packages/opencode/src/tool/plan.ts` now calls `bootstrapBuilderBeta()` only when approved planner artifacts opt into the beta workflow and persists resolved branch/worktree/runtime metadata into `mission.beta`.
- Completed syncback / validation runtime wiring in build mode:
  - `packages/opencode/src/session/workflow-runner.ts` detects beta validation continuations from mission/delegation metadata.
  - Validation continuations call `prepareBuilderBetaValidation()` before execution.
  - Non-manual runtime policies additionally call `executeBuilderBetaSyncback()` so builder checks out the validated branch in the main worktree and triggers the configured runtime command before the testing slice continues.
  - Manual runtime policies remain stop-gated: validation metadata is attached, but runtime execution is not guessed or auto-run.
- Completed finalize / merge preflight wiring:
  - `packages/opencode/src/session/beta-bootstrap.ts` now provides `prepareBuilderBetaFinalize()` with clean-main and committed-beta-head checks plus merge-target resolution.
  - `packages/opencode/src/session/workflow-runner.ts` detects finalize-oriented continuations and injects finalize preflight metadata plus explicit approval messaging.
  - Finalize preflight prepares merge command / target / cleanup defaults but does not execute merge or cleanup automatically.
  - `packages/opencode/src/session/workflow-runner.test.ts` now covers beta finalize preflight metadata and the preserved approval gate.
- Completed approval-confirmed drift remediation execute path:
  - `packages/opencode/src/session/beta-bootstrap.ts` now allows explicit destructive-gate remediation approval to execute `git rebase <baseBranch>` from the beta worktree.
  - Remediation execute re-checks clean committed beta-head invariants before rebasing and returns fail-fast blocked results on dirty state or rebase conflict.
  - Successful remediation returns an updated finalize preflight without merging, so finalize remains a separate approval-gated step.
  - `packages/opencode/src/session/beta-bootstrap.test.ts` now covers remediation execute success, dirty-worktree block, and rebase-conflict block.
- Completed routine remote pull/push automation and migration/deprecation runtime surfacing:
  - `packages/opencode/src/session/beta-bootstrap.ts` now executes builder-owned routine `pull` only from a clean committed beta head, requires explicit `origin` remote and upstream tracking, and uses `git pull --ff-only`.
  - The same routine surface now executes `push -u origin <branch>` when explicitly requested and approved by policy metadata; push still fail-fast blocks when approval is required but absent.
  - `packages/mcp/branch-cicd/src/beta-tool.ts` messaging and question details now explicitly position beta-tool as back-compat / migration scaffolding and prefer builder-native workflow when available.
  - Final removal condition is now explicit in runtime/docs: builder-native flow owns bootstrap, routine git, validation syncback, remediation, and finalize; beta/dev MCP remains only as compatibility scaffolding until maintainers choose to remove it.

## Validation

- `bun test packages/opencode/src/session/beta-bootstrap.test.ts packages/opencode/src/session/workflow-runner.test.ts`
  - Final focused validation in beta worktree passed cleanly after remote automation + MCP migration/deprecation updates.
  - Bun summary observed in beta worktree: `120 pass, 0 fail, 288 expect() calls, 120 tests across 2 files`.
  - Coverage now includes remediation execute success, dirty/conflict fail-fast behavior, remote pull fail-fast on missing origin/upstream, successful remote pull+push under explicit approval, and workflow-runner gating around builder-owned beta operations.
- Plan-vs-implementation review:
  - The active plan goal is now effectively satisfied for builder-native bootstrap, routine git orchestration, syncback validation, drift remediation, and approval-gated finalize.
  - Remaining open question is no longer missing implementation but lifecycle policy: beta/dev MCP still exists as compatibility scaffolding and would need a separate user-approved removal change to disappear entirely.
  - No additional implementation gap was found against the active plan’s functional scope beyond that deliberate compatibility hold.
- Architecture Sync: updated `specs/architecture.md` because builder-native beta bootstrap, validation syncback/runtime execution, finalize preflight/execute, drift-remediation preflight/execute, routine git defaults including remote pull/push policy, planner-root guard, and MCP migration-scaffolding end-state are now durable runtime/module-boundary behavior.

## Remaining

- Beta/dev MCP still remains as compatibility scaffolding and has not yet been physically removed; removing it would be a separate follow-up change rather than a missing builder-native capability.
- If broader regression confidence is needed, the next step is to expand validation beyond the focused beta/planner suite to cover any surrounding builder workflows that may consume the new mission/routine-git metadata.
