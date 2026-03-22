# Tasks

## 1. Planner Root Integrity Guard

- [x] 1.1 Add `plan_enter` checks that distinguish empty/template roots from real or partial curated planner roots
- [x] 1.2 Add regression tests so `plan_enter` never blindly overwrites existing non-template planner content

## 2. Builder Compatibility Guard

- [x] 2.1 Inventory current builder responsibilities and preserve backward-compatible non-beta behavior
- [x] 2.2 Define explicit beta-enabled mission metadata without regressing legacy build flows

## 3. Builder-Native Beta Primitives

- [x] 3.1 Extract and internalize shared branch/worktree/runtime primitives from current beta-tool logic
- [x] 3.2 Keep temporary compatibility adapters only as needed during migration away from beta/dev MCP

## 4. Build Entry Optimization

- [x] 4.1 Extend `plan_exit` to bootstrap beta flow only when planner artifacts opt into it
- [x] 4.2 Persist beta execution context in mission / handoff metadata for build mode

## 5. Routine Git Flow Optimization

- [x] 5.1 Define builder-owned defaults for routine `commit` timing and commit-safety gates
- [x] 5.2 Define builder-owned defaults for `push/pull/checkout` and remote approval boundaries
- [x] 5.3 Implement the approved routine git defaults in builder runtime / metadata flow (commit/checkout/pull landed; push is implemented but still approval-gated by policy where required)

## 6. Validation Flow Optimization

- [x] 6.1 Add build-mode validation support for syncback-equivalent main-worktree updates
- [x] 6.2 Add runtime policy execution / manual stop behavior for validation slices

## 7. Finalize Flow Optimization

- [x] 7.1 Add builder-owned merge preflight after successful validation
- [x] 7.2 Enforce explicit approval gate before merge / cleanup execution
- [x] 7.3 Add approval-confirmed merge execute path while keeping cleanup conservative by default

## 8. State Remediation Flow

- [x] 8.1 Detect branch drift when main/base branch advances after beta bootstrap
- [x] 8.2 Prepare approval-gated rebase/remediation preflight for common drift cases
- [x] 8.3 Block remediation when beta branch is not a clean committed head
- [x] 8.4 Add approval-confirmed rebase/remediation execute path with fail-fast conflict handling

## 9. Migration / Deprecation

- [x] 9.1 Mark beta/dev MCP as non-required migration scaffolding in runtime/docs
- [x] 9.2 Define the final removal conditions for beta/dev MCP once builder-native flow is complete

## 10. Regression + Validation

- [x] 10.1 Add targeted tests for planner overwrite protection, beta handoff, bootstrap, validation, and finalize preflight/execute metadata
- [x] 10.2 Add targeted coverage for branch drift / remediation preflight and execute paths
- [x] 10.3 Verify builder-native deterministic primitives reduce routine AI orchestration and do not break existing builder flow
- [x] 10.4 Resolve the beta worktree test-environment issue (`zod` resolution) and obtain a clean validation pass

## 11. Documentation / Retrospective

- [x] 11.1 Sync event log and architecture docs for builder/beta integration checkpoints
- [x] 11.2 Compare the final implementation against this plan’s effective requirement description
- [x] 11.3 Update docs/specs for routine git defaults, drift remediation, and MCP deprecation end-state