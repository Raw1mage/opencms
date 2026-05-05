# Self-Restart Handover Checkpoint

## Requirement

When `system-manager_restart_self` initiates a controlled rebuild/restart of the OpenCode runtime, the active AI turn must persist a durable handover file before the daemon/gateway can interrupt the socket. The next runtime/session must be able to recover what was attempted, why, and what evidence is still needed.

## Scope

### In

- Add a deterministic self-restart handover checkpoint written before restart orchestration begins.
- Preserve enough context to continue after gateway/daemon interruption: session id, timestamp, reason, dirty git summary, active plan/task references, and validation follow-up.
- Store the checkpoint under an opencode-owned state path, not in prompt-only memory.
- Make restart result reporting fail-safe: socket close means `unknown/pending`, not success.
- Add focused validation for checkpoint write/read behavior where practical.

### Out

- Changing daemon lifecycle authority or adding bash-based restart paths.
- Persisting secrets or full conversation transcripts in the checkpoint.
- Replacing existing session persistence or message-stream compaction.

## Constraints

- No fallback mechanism: if checkpoint write fails, restart must fail fast rather than proceed without durable handover.
- The checkpoint must avoid credentials, environment dumps, and raw API keys.
- Restart remains gateway-owned through `system-manager_restart_self` / `/global/web/restart`.

## Revision History

- 2026-05-05: Initial proposal after restart socket closed without reliable continuation evidence.
