# Tasks

## 1. Planning Follow-through

- [ ] 1.1 Read `implementation-spec.md`, `proposal.md`, `spec.md`, `design.md`, and this task list
- [ ] 1.2 Confirm the recovery value order and stop gates
- [ ] 1.3 Confirm build resumes through beta workflow bootstrap before any code-bearing slice

## 2. Bootstrap beta execution surface

- [ ] 2.1 Restate and verify the beta authority tuple against `recovery/cms-codex-20260401-183212`
- [ ] 2.2 Create a new disposable `beta/*` branch and worktree for the active recovery workstream
- [ ] 2.3 Record beta bootstrap evidence and stop if authority/worktree state is inconsistent

## 3. Recover Claude Native source scaffold

- [~] 3.1 Reconstruct the surviving Claude Native / `claude-provider` behavior from historical evidence and current recovery code — blocked in prior attempt because current tree has no `packages/opencode-claude-provider` source scaffold and no live `claude-native` integration surface; use this as evidence for the narrower sub-stages below
- [ ] 3.2 Recreate the minimum source scaffold for `packages/opencode-claude-provider` on the beta execution surface
- [ ] 3.3 Run bounded validation proving the scaffold is live and correctly wired into the repo build surface

## 4. Recover Claude Native auth bridge and loader wiring

- [ ] 4.1 Reconstruct the native auth storage bridge between historical `claude-provider` auth state and current opencode account/runtime surfaces
- [ ] 4.2 Refactor the minimum viable loader/plugin wiring for `claude-native` into the beta execution surface
- [ ] 4.3 Run targeted validation for auth bridge and loader initialization

## 5. Activate the minimum viable Claude Native path

- [ ] 5.1 Enable the minimum viable Claude Native execution path only after scaffold and bridge slices are in place
- [ ] 5.2 Run targeted Claude Native / `claude-provider` validation and record evidence
- [ ] 5.3 Decide whether any remaining Claude Native backlog stays deferred before moving to later slices

## 6. Recover runtime/context optimization hardening

- [ ] 6.1 Reconstruct the missing runtime/context hardening behavior from historical evidence
- [ ] 6.2 Refactor the selected runtime/context hardening slice into the beta implementation surface
- [ ] 6.3 Run targeted validation and record evidence

## 7. Recover rebind / continuation / session hardening

- [ ] 7.1 Reconstruct the missing rebind / continuation / session hardening behavior from historical evidence
- [ ] 7.2 Refactor the selected session hardening slice into the beta implementation surface
- [ ] 7.3 Run targeted validation and record evidence

## 8. Recover remaining provider-manager completion slice

- [ ] 8.1 Isolate the still-missing provider-manager behavior beyond the restored `模型提供者` UI slice
- [ ] 8.2 Refactor the remaining provider-manager slice into the beta implementation surface
- [ ] 8.3 Run targeted provider/webapp validation and record evidence

## 9. Documentation / Retrospective

- [ ] 9.1 Sync relevant architecture / event docs after each slice or record `Architecture Sync: Verified (No doc changes)`
- [ ] 9.2 Compare implementation results against the proposal's effective requirement description
- [ ] 9.3 Produce a validation checklist covering restored behavior, partial fulfillment, deferred items, and evidence

<!--
Unchecked checklist items are the planner handoff seed for runtime todo materialization.
Checked items may remain for human readability, but they are not used as new todo seeds.
Runtime todo is the visible execution ledger and must not be replaced by a private parallel checklist.
-->
