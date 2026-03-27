# Tasks

## 1. Consolidate Baseline

- [x] 1.1 Re-read scheduler durability evidence from `specs/scheduler-channels/`, `specs/architecture.md`, and 2026-03-27 cron events
- [x] 1.2 Rewrite planner artifacts so durable cron scheduler reflects current implementation truth

## 2. Harden Runtime Evidence

- [x] 2.1 Add or refine the first regression slice around daemon lifecycle / heartbeat registration / scheduler recovery
- [x] 2.2 Integrate a live validation slice that proves run-log and `/system/tasks` execution evidence move in the real runtime path

## 3. Validate Durable Scheduler Behavior

- [x] 3.1 Run targeted cron store / heartbeat / lifecycle validation
- [x] 3.2 Record exact operator-visible evidence and fail if runtime execution proof is missing

## 4. Sync Documentation

- [x] 4.1 Update `docs/events/` with the durable scheduler hardening result and checkpoints
- [x] 4.2 Sync `specs/architecture.md` or record `Verified (No doc changes)` with explicit basis
