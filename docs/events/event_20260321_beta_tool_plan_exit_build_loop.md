# Event: Beta Tool Plan Exit Build Loop Integration Planning

**Date**: 2026-03-21
**Status**: Planning

---

## Requirement

User requested that the beta-tool workflow stop being an MCP-only side path and instead integrate directly into the existing builder workflow, so that when `plan_exit` asks whether to start build mode and the answer is yes, the system automatically follows the beta development flow.

The requirement was later clarified with hard constraints:

1. Do **not** break existing builder functionality; optimize the current hardcoded builder instead of replacing it.
2. Keep the change focused on process optimization so builder (a) understands beta development flow and (b) uses related deterministic tools/primitives to reduce AI dependence for routine work.
3. Final UX target: once the user enters build mode, they should no longer need to keep prompting for routine branch checkout, commit, push, pull, and related orchestration details; builder should manage those defaults on a safe beta branch/worktree and return a testable branch to the main repo before merge approval.
4. Final steady state: users should no longer need `mcp dev-tool / beta-tool` in normal workflow because the capability is built into the hardcoded builder.
5. `plan_enter` must not blindly overwrite existing plan roots; overwrite protection is now an explicit requirement in this same change set.

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

- `plan_exit` currently validates planner artifacts, materializes todos, sets mission metadata, and injects a synthetic build-mode handoff.
- Mission schema currently carries generic approved-plan metadata but no beta-aware lifecycle contract.
- Workflow runner currently controls continuation, blockers, approvals, and pending questions for build mode.
- Existing beta-tool logic already contains deterministic branch/worktree/runtime flow semantics suitable for internalization into builder-owned behavior.
- `PlanEnterTool` currently checks only whether `implementation-spec.md` exists before writing all templates, so a partial or damaged root can be overwritten too aggressively.

### Root Decision

- Optimize the existing builder control plane instead of replacing it.
- Internalize deterministic beta primitives/tooling so routine orchestration shifts away from repeated AI reasoning.
- Preserve non-beta builder compatibility and keep merge approval-gated.
- Include routine remote operations (push/pull) in the builder-owned flow where policy allows, so users do not need to keep prompting for them.
- Treat beta/dev MCP as migration scaffolding only, then deprecate/remove it once builder-native workflow is validated.
- Add `plan_enter` planner-root integrity checks so existing curated artifacts are reused or blocked instead of silently overwritten.

## Key Decisions

1. Existing builder remains the backbone.
2. Builder becomes beta-aware through narrow flow changes.
3. Deterministic beta primitives are preferred over prompt-only orchestration.
4. Non-beta compatibility is a first-class validation target.
5. Merge/cleanup remain explicit approval-gated operations.
6. Routine commit/push/pull/checkout should become builder-owned defaults where policy permits.
7. `mcp dev-tool / beta-tool` is not the target end state and should be deprecated/removed after migration.

## Validation

- Repaired active planner artifacts under `/home/pkcs12/projects/opencode/plans/20260321_beta-tool/` after template reset was detected.
- Updated:
  - `implementation-spec.md`
  - `proposal.md`
  - `spec.md`
  - `design.md`
  - `tasks.md`
  - `handoff.md`
  - `idef0.json`
  - `grafcet.json`
  - `c4.json`
  - `sequence.json`
- Architecture Sync: pending implementation; final builder/module boundary changes should be synced once code changes confirm the durable structure.

## Remaining

- Internalize deterministic beta primitives/tool reuse into builder-native flow.
- Extend `plan_exit`, mission metadata, and workflow-runner with beta-aware flow while preserving non-beta behavior.
- Implement `plan_enter` overwrite protection and tests.
- Decide exact approval boundaries for remote operations inside builder.
- Validate regression safety and reduced routine AI orchestration.
- Plan deprecation/removal of beta/dev MCP after builder-native path is proven.
- Sync `specs/architecture.md` after implementation confirms final boundaries.
