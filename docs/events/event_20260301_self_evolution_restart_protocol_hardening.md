# Event: self-evolution restart protocol hardening

Date: 2026-03-01
Status: Done

## Goal

Strengthen the "self-update / self-restart" path so webctl can safely restart the service even when command execution originates from web-backed sessions.

## Key Decisions

1. **Detached restart by default**
   - `webctl.sh restart` now schedules `_restart-worker` via `nohup`.
   - Rationale: avoid caller-session interruption during stop/start transition.

2. **Concurrency guard with restart lock**
   - Added lock file: `${XDG_RUNTIME_DIR:-/tmp}/opencode-web-restart-<profile>.lock`.
   - Rationale: prevent overlapping restart operations.

3. **Structured restart ledger (JSONL)**
   - Added event log: `${XDG_RUNTIME_DIR:-/tmp}/opencode-web-restart-<profile>.jsonl`.
   - Each transaction records schedule/lock/worker/stop/start/health/restart stages.
   - Rationale: observability and postmortem-friendly diagnostics.

4. **Graceful preflight mode**
   - Added `restart --graceful` preflight checks before shutdown.
   - Rationale: reduce avoidable downtime when prerequisites are missing.

5. **Public URL output decoupled from bind host**
   - Added `OPENCODE_PUBLIC_URL` display variable.
   - Rationale: status/start output should match externally accessed URL in reverse-proxy deployments.

## Files Changed

- `webctl.sh`
- `README.md`

## Validation

- Script syntax check passes.
- `./webctl.sh restart` schedules detached worker and completes.
- `./webctl.sh status` returns healthy after restart settling.
