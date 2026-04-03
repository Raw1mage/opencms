# Tasks

## 1. Baseline And Restore Matrix

- [ ] 1.1 Read the approved implementation spec and proposal before touching code
- [ ] 1.2 Build a complete missing-commit appendix for the remaining 42/43-scale gap, including stragglers that do not fit the first-pass major buckets
- [ ] 1.3 Map every inventoried commit to a decision status (`restore`, `skip`, `already redone`, `needs deeper analysis`)
- [ ] 1.4 For every functional commit/slice, perform supersession review against later history before approving any restore shape
- [ ] 1.5 Build a per-bucket restore matrix for approved buckets versus current `main`
- [ ] 1.6 Mark provider manager as skipped because the user already redid that area
- [ ] 1.7 Decompose overlapping mixed commits and deduplicate them against already-redone or separately-approved slices before any restore implementation
- [ ] 1.8 Reconstruct each remaining commit family toward its newest workable version, preserving iteration/override evidence
- [ ] 1.9 Reconstruct related plans/specs/docs artifacts toward their newest coherent document state, preserving historical intent and overwrite relations

## 1A. Reconstruction Problem Decomposition

- [x] 1A.1 Split R1-R8 into subproblems with explicit dependencies
- [x] 1A.2 Mark which subproblems are confirmed rebuilds, deeper-analysis items, mixed-bucket dedup cases, or keep-deprecated candidates
- [x] 1A.3 Build a latest-HEAD reconstruction order that respects supersession and avoids replaying obsolete intermediate patches
- [x] 1A.4 Keep `reconstruction-map.md` aligned with actual branch/test-branch execution waves

## 1B. Branch / Wave Execution Strategy

- [x] 1B.1 Assign each reconstruction wave to a default `test/*` branch strategy
- [x] 1B.2 Define entry / exit / fetch-back conditions for each wave branch
- [ ] 1B.3 Enforce branch cleanup after each wave is fetched back or merged back

## 2. Restore Visible Product Slice

- [x] 2.1 Diff and restore branding/browser-tab behavior (`TheSmartAI`, title, icon/logo route)
- [x] 2.2 Validate browser title/icon behavior in source and runtime-facing outputs

## 3. Restore Runtime Hardening Slice

- [x] 3.1 Diff and restore rebind / checkpoint / continuation hardening gaps
- [x] 3.2 Diff and restore subagent lifecycle / weak-model failure protection gaps
- [x] 3.3 Validate session/rebind/checkpoint behavior with targeted tests or focused evidence

## 4. Restore Smaller Approved Buckets

- [x] 4.1 Diff and restore GitHub Copilot reasoning variants gaps
- [x] 4.2 Diff and restore `llm packet debug / tests` gaps
- [x] 4.3 Validate both buckets and record what was truly missing versus already present

## 5. Restore Larger Capability Buckets

- [x] 5.1 Diff and decompose `Claude Native / claude-provider` into smaller executable restore slices
- [x] 5.2 Reconstruct the remaining `claude` chain toward the newest workable version, preserving iteration/override evidence
- [x] 5.3 Restore the approved `Claude Native / claude-provider` slices without overwriting newer behavior
- [x] 5.4 Diff and restore approved `user-init / onboarding / marketplace` gaps

## 6. Validation And Documentation

- [x] 6.1 Run targeted validation for every restored bucket
- [x] 6.2 Update `docs/events/event_20260401_cms_codex_recovery.md` with restore evidence and skipped/deferred notes
- [x] 6.3 Compare final results against the proposal's effective requirement description

<!--
Unchecked checklist items are the planner handoff seed for runtime todo materialization.
Checked items may remain for human readability, but they are not used as new todo seeds.
Runtime todo is the visible execution ledger and must not be replaced by a private parallel checklist.
-->
