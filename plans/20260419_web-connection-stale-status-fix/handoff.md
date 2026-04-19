# Handoff — web connection stale status fix

## Execution Contract

- Remain on the beta worktree.
- Do not enter build mode without explicit user approval.
- Preserve fail-fast authority semantics; do not add silent fallback behavior.

## Required Reads

- `plans/20260419_web-connection-stale-status-fix/proposal.md`
- `plans/20260419_web-connection-stale-status-fix/spec.md`
- `plans/20260419_web-connection-stale-status-fix/design.md`
- `plans/20260419_web-connection-stale-status-fix/implementation-spec.md`
- `plans/20260419_web-connection-stale-status-fix/tasks.md`

## Stop Gates In Force

- Stop if no authoritative API/snapshot can confirm active-child and session status after reconnect.
- Stop if proposed UI behavior would reintroduce silent fallback semantics.
- Stop if input blocking conflicts with essential abort/stop controls and no safe exception contract exists.

## Execution-Ready Checklist

- [ ] Connection-state authority sources identified
- [ ] Counter semantics agreed (running duration vs stale-since)
- [ ] Rehydrate flow specified for reconnect/reload/resume
- [ ] Input blocking rules verified against existing controls
