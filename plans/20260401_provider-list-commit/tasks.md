# Tasks

## 1. Planning Follow-through

- [x] 1.1 Read `implementation-spec.md`, `proposal.md`, `spec.md`, `design.md`, and this task list
- [x] 1.2 Confirm the recovery value order and stop gates
- [x] 1.3 Confirm build resumes through beta workflow bootstrap before any code-bearing slice

## 2. Bootstrap beta execution surface

- [x] 2.1 Restate and verify the beta authority tuple against `recovery/cms-codex-20260401-183212`
- [x] 2.2 Create a new disposable `beta/*` branch and worktree for the active recovery workstream
- [x] 2.3 Record beta bootstrap evidence and stop if authority/worktree state is inconsistent

## 3. Recover Claude Native source scaffold

- [~] 3.1 Reconstruct the surviving Claude Native / `claude-provider` behavior from historical evidence and current recovery code — original oversized slice was blocked by missing scaffold/live integration; practical recovery is now completed through `3.2`–`5.3`, so this item remains as historical evidence only
- [x] 3.2 Recreate the minimum source scaffold for `packages/opencode-claude-provider` on the beta execution surface
- [x] 3.3 Run bounded validation proving the scaffold is live and correctly wired into the repo build surface

## 4. Recover Claude Native auth bridge and loader wiring

- [x] 4.1 Reconstruct the native auth storage bridge between historical `claude-provider` auth state and current opencode account/runtime surfaces
- [x] 4.2 Refactor the minimum viable loader/plugin wiring for `claude-native` into the beta execution surface
- [x] 4.3 Run targeted validation for auth bridge and loader initialization

## 5. Activate the minimum viable Claude Native path

- [x] 5.1 Enable the minimum viable Claude Native execution path only after scaffold and bridge slices are in place
- [x] 5.2 Run targeted Claude Native / `claude-provider` validation and record evidence
- [x] 5.3 Decide whether any remaining Claude Native backlog stays deferred before moving to later slices

## 6. Recover runtime/context optimization hardening

- [x] 6.1 Reconstruct the missing runtime/context hardening behavior from historical evidence
- [x] 6.2a Refactor lazy tool loading / adaptive auto-load and its follow-up correctness fixes into the beta implementation surface
- [x] 6.2b Refactor small-context compaction truncation safeguards into the beta implementation surface
- [x] 6.2c Refactor toolcall schema / error-recovery guidance hardening into the beta implementation surface
- [x] 6.3 Run targeted validation for the selected `6.2*` slice and record evidence

## 7. Recover rebind / continuation / session hardening

- [x] 7.1 Reconstruct the missing rebind / continuation / session hardening behavior from historical evidence
- [x] 7.2a Refactor rebind checkpoint durability + safe checkpoint injection into the beta implementation surface
- [~] 7.2b Revisit any still-proven continuation/session leftovers only after `7.2a` validation — no additional proven gap remains after `7.2a`; keep deferred unless new evidence appears
- [x] 7.3 Run targeted validation for the selected `7.2*` slice and record evidence

## 8. Recover remaining provider-manager completion slice

- [x] 8.1 Isolate the still-missing provider-manager behavior beyond the restored `模型提供者` UI slice
- [x] 8.2a Refactor webapp model-manager provider visibility/favorites semantics into the beta implementation surface
- [~] 8.2b Revisit dialog reopen geometry cleanup only if still needed after `8.2a` — default deferred; resume only with new reopen-geometry defect evidence
- [x] 8.3 Run targeted provider/webapp validation for the selected `8.2*` slice and record evidence
- [x] 8.4a Remediate target `dialog-select-model.tsx` type/readiness issues that block confident closure
- [x] 8.4b Add direct execution coverage for the hidden-provider localStorage path
- [x] 8.5 Re-run focused provider/webapp validation after `8.4*` and record updated evidence

## 9. Documentation / Retrospective

- [x] 9.1 Sync relevant architecture / event docs after each slice or record `Architecture Sync: Verified (No doc changes)`
- [x] 9.2 Compare implementation results against the proposal's effective requirement description and restate requirement coverage
- [x] 9.3 Produce a validation checklist covering restored behavior, partial fulfillment, deferred items, and evidence

## 10. Finalize Gate (approval required)

- [x] 10.1 Prepare fetch-back / finalize recommendation from `8.5` + `9.2` + `9.3` evidence
- [ ] 10.2 Stop for user approval before fetch-back / finalize / cleanup
- [ ] 10.3 After approval, delete disposable `beta/*` branch and worktree as completion gate

<!--
Unchecked checklist items are the planner handoff seed for runtime todo materialization.
Checked items may remain for human readability, but they are not used as new todo seeds.
Runtime todo is the visible execution ledger and must not be replaced by a private parallel checklist.
-->
