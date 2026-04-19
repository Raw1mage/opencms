# Tasks — web connection stale status fix

## A. Reconfirm authority surfaces

- [x] A1 Inspect current authority sources for session status, active child, and monitor snapshots
- [x] A2 Identify which frontend surfaces currently derive fake running from local stale projection
- [x] A3 Document exact APIs/events used for reconnect revalidation

## B. Design connection-state contract

- [x] B1 Define web connection state machine (`connected`, `reconnecting`, `degraded`, `resyncing`, `blocked`)
- [x] B2 Define transition rules between transport failure, reconnect attempt, and authoritative recovery
- [x] B3 Define which UI surfaces must degrade immediately when authority is uncertain

## C. Design stale footer / counter behavior

- [x] C1 Replace ambiguous elapsed semantics with explicit runtime/stale semantics
- [x] C2 Define when subagent footer should clear vs downgrade vs recover
- [x] C3 Define reload / reconnect / foreground resume counter reset rules

## D. Design guarded input behavior

- [x] D1 Define prompt-input blocking policy during degraded/reconnecting states
- [x] D2 Define operator feedback surface (toast/banner/footer copy)
- [x] D3 Define exceptions for stop/abort actions if applicable

## E. Validation and documentation

- [x] E1 Prepare targeted test/repro matrix for weak network and reconnect scenarios
- [x] E2 Update event log with final RCA + implementation plan
- [x] E3 Sync `specs/architecture.md` if the contract changes module/runtime boundaries

## Current Status

- Implemented in beta worktree. Architecture sync completed.
