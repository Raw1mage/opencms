# Self-Restart Handover Checkpoint Tasks

## 1. Discovery and contract

- [x] 1.1 Record requirement/event baseline and XDG backup.
- [x] 1.2 Trace `system-manager_restart_self`, `/global/web/restart`, and gateway-daemon restart control path.
- [x] 1.3 Trace existing session handover/checkpoint/state storage surfaces.

## 2. Design

- [x] 2.1 Define checkpoint schema and taxonomy: path, fields, redaction rules, lifecycle states.
- [x] 2.2 Define write/read/cleanup contract and failure policy.
- [x] 2.3 Update architecture/event docs with restart handover boundary.

## 3. Implementation

- [x] 3.1 Implement checkpoint writer before restart orchestration.
- [x] 3.2 Implement checkpoint read/status surface for post-restart continuation.
- [x] 3.3 Add focused tests for write failure fail-fast and successful checkpoint persistence.

## 4. Validation

- [x] 4.1 Run focused tests/typecheck.
- [x] 4.2 Manually validate restart attempt reports `pending/unknown` when socket closes.
- [x] 4.3 Record validation and backup location in event log.
