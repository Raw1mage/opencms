# Tasks

## 1. Define operator state model

- [x] 1.1 Formalize the project-context / main-worktree / beta-worktree / feature-branch state contract
- [x] 1.2 Define destructive-operation approval gates and dirty-tree blockers
- [x] 1.3 Finalize MCP tool names, context inputs, structured outputs, and `question` interaction checkpoints

## 2. Build the MCP package

- [x] 2.1 Create `packages/mcp/branch-cicd` package scaffolding aligned with existing MCP packages
- [x] 2.2 Implement project-context resolution, git/worktree inspection, and loop metadata helpers
- [x] 2.3 Implement `resolve_project_context`, `newbeta`, and `get_loop_status`
- [x] 2.4 Implement `syncback` and project-aware runtime handoff
- [x] 2.5 Implement approval-gated `merge`
- [x] 2.6 Implement `question`-driven ambiguity handling for branch naming, merge target, runtime policy, and destructive confirmation

## 3. Validate the workflow

- [x] 3.1 Run package typecheck/build validation for the new MCP package
- [x] 3.2 Exercise context resolution plus a disposable feature branch loop through `newbeta` → `syncback` → runtime start
- [x] 3.3 Exercise fail-fast cases for dirty-tree, missing-path, and collision blockers
- [x] 3.4 Exercise guarded `merge` or dry-run merge and record evidence
- [x] 3.5 Exercise `question` flows for ambiguous context and destructive confirmation

## 4. Sync docs and retrospective

- [x] 4.1 Update enablement metadata for the new MCP capability
- [x] 4.2 Sync `specs/architecture.md` with the new project-aware branch/worktree orchestration surface
- [x] 4.3 Update `docs/events/event_20260321_branch_repo_mcp_cicd.md` with checkpoints, decisions, and validation
- [x] 4.4 Compare implementation results against the proposal's effective requirement description

<!--
Unchecked checklist items are the planner handoff seed for runtime todo materialization.
Checked items may remain for human readability, but they are not used as new todo seeds.
Runtime todo is the visible execution ledger and must not be replaced by a private parallel checklist.
-->
