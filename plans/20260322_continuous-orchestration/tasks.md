# Tasks

## 1. Baseline And Control-State Trace

- [ ] 1.1 Trace current stop-button lifecycle versus active background-subagent evidence across runtime, Web, and TUI.
- [ ] 1.2 Identify the authoritative child-session metadata, progress evidence, current child-entry mechanisms, and thinking/elapsed status-bar reuse points for both Web and TUI.
- [ ] 1.3 Lock the staged stop contract and fail-fast conditions in code-facing notes before editing runtime behavior.

## 2. Runtime Stop / Active-Subagent Authority

- [ ] 2.1 Add or normalize one authoritative active-background-subagent state per parent session.
- [ ] 2.2 Implement staged stop behavior: first stop interrupts foreground Orchestrator activity, second stop terminates the active child.
- [ ] 2.3 Preserve single-subagent fail-fast behavior while allowing parent conversation and non-task tool calls during background execution.

## 3. Web And TUI Status Surfaces

- [x] 3.1 Extend the Web thinking/elapsed bottom-status surface into an active-subagent status bar with child-session route entry. (Current Web surface is now a single-line compact bar showing `@agent`, title, current step, and elapsed time with icon-only open entry.)
- [ ] 3.2 Extend the TUI thinking/elapsed bottom-status surface with session-tree jump entry for the active child.
- [ ] 3.3 Ensure both surfaces keep rendering until authoritative parent-takeover or child-clear evidence is observed.

## 4. Validation And Documentation

- [~] 4.1 Add or update targeted tests for stop escalation, active-child visibility, and second-subagent rejection. (Focused stale-active-child tests added in `packages/opencode/test/tool/task.test.ts`, but current task test fixture schema is outdated and blocks green execution.)
- [~] 4.2 Run repo-appropriate validation and collect manual/runtime evidence for the handoff timing contract. (Focused validation rerun completed; green status blocked by pre-existing task-test fixture/schema drift and unrelated package type errors.)
- [x] 4.3 Update `docs/events/event_20260322_continuous_orchestration.md` with the new regression scope, decisions, and validation.
- [x] 4.4 Sync `specs/architecture.md` with the active-subagent control-surface contract.
- [x] 4.5 Compare implementation results against the revised proposal and report any remaining gaps.
