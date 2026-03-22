# Tasks

## 1. Planner Root Integrity Guard

- [ ] 1.1 Add `plan_enter` checks that distinguish empty/template roots from real or partial curated planner roots
- [ ] 1.2 Add regression tests so `plan_enter` never blindly overwrites existing non-template planner content

## 2. Builder Compatibility Guard

- [ ] 2.1 Inventory current builder responsibilities and preserve backward-compatible non-beta behavior
- [ ] 2.2 Define explicit beta-enabled mission metadata without regressing legacy build flows

## 3. Builder-Native Beta Primitives

- [ ] 3.1 Extract and internalize shared branch/worktree/runtime primitives from current beta-tool logic
- [ ] 3.2 Keep temporary compatibility adapters only as needed during migration away from beta/dev MCP

## 4. Build Entry Optimization

- [ ] 4.1 Extend `plan_exit` to bootstrap beta flow only when planner artifacts opt into it
- [ ] 4.2 Persist beta execution context in mission / handoff metadata for build mode

## 5. Routine Git Flow Optimization

- [ ] 5.1 Add builder-owned defaults for routine branch/checkout/commit/push/pull orchestration where policy allows
- [ ] 5.2 Enforce clean committed-head checks before bootstrap and before syncback validation
- [ ] 5.3 Keep explicit approval boundaries for remote/destructive operations that still require operator consent

## 6. Validation Flow Optimization

- [ ] 6.1 Add build-mode validation support for syncback-equivalent main-worktree updates
- [ ] 6.2 Add runtime policy execution / manual stop behavior for validation slices

## 7. Finalize Flow Optimization

- [ ] 7.1 Add builder-owned merge preflight after successful validation
- [ ] 7.2 Enforce explicit approval gate before merge / cleanup execution

## 8. Migration / Deprecation

- [ ] 8.1 Mark beta/dev MCP as non-required migration scaffolding
- [ ] 8.2 Plan final removal once builder-native workflow is validated

## 9. Regression + Token Validation

- [ ] 9.1 Add or update targeted tests for builder compatibility, `plan_enter` overwrite protection, beta-aware handoff, and clean-head branch invariants
- [ ] 9.2 Verify builder-native deterministic primitives reduce routine AI orchestration and do not break existing builder flow

## 10. Documentation / Retrospective

- [ ] 10.1 Sync event log and architecture docs for builder/beta integration
- [ ] 10.2 Compare the final implementation against this plan’s effective requirement description
