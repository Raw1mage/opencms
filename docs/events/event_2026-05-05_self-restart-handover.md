# Event — Self-Restart Handover Checkpoint

## Requirement

User clarified that self-restart must persist a durable handover file because gateway/daemon interruption can break the socket and lose AI turn memory.

## Scope

### In

- Design and implement a restart handover checkpoint before controlled self-restart.
- Ensure restart result reporting does not treat socket close as success.
- Preserve continuation evidence without secrets.

### Out

- Bash daemon restart/spawn paths.
- Secret-bearing snapshots.

## Task List

- `plans/20260505_self_restart_handover/tasks.md`.

## Debug Checkpoints

- Baseline: `system-manager_restart_self` returned `socket connection was closed unexpectedly`; this is ambiguous between successful restart interruption and failed request.
- Initial root concern: current restart flow lacks a durable handover file that survives daemon/gateway interruption.
- Boundary evidence: `packages/mcp/system-manager/src/index.ts` previously only posted `/global/web/restart`; `packages/opencode/src/server/routes/global.ts` generated txid inside the daemon and then invoked webctl/self-update. If the socket closed before response parsing, AI had neither txid nor handover path.
- Existing restart audit (`packages/opencode/src/server/self-update.ts`) records privileged action results only; it does not preserve active AI session continuation context.

## Root Cause

Self-restart had a durability gap between AI intent and gateway-owned restart execution. The restart endpoint could safely rebuild/restart the daemon, but the initiating AI turn relied on in-memory context and a live socket response. Gateway/daemon interruption made the result unknowable and could lose the continuation instructions.

## Implementation

- Added `packages/opencode/src/server/restart-handover.ts` to write redacted JSON checkpoints under `Global.Path.state/restart-handover/<txid>.json`.
- `/global/web/restart` now accepts optional `txid`, `sessionID`, and `handover`; it writes the checkpoint before invoking webctl or privileged self-update actions and returns `handoverPath` on accepted requests.
- `system-manager_restart_self` now writes a preflight checkpoint before HTTP POST, sends the same txid to the daemon, and reports `status unknown` plus checkpoint path if the socket closes.
- `specs/architecture.md` records the controlled self-restart handover boundary.

## Validation

- `bun test --timeout 15000 packages/opencode/test/server/restart-handover.test.ts` passed (2 tests, 8 assertions).
- `bun run --cwd packages/opencode typecheck` still fails on existing baseline errors outside this slice (`opencode-codex-provider`, CLI command arity, TUI `sessionId`, existing `server/routes/session.ts`, `message-v2.ts`, `share-next.ts`, etc.).
- `bun run --cwd packages/mcp/system-manager typecheck` still fails on existing workspace baseline (`@opencode-ai/console-function` missing `sst`), before this specific MCP helper can be isolated by package typecheck.
- Manual restart smoke is not run in this turn; future restart calls should pass `sessionID`/`handover` and then verify `handoverPath` or preflight checkpoint after reconnect.

## Backup

- XDG whitelist backup: `~/.config/opencode.bak-20260505-self-restart-handover/`.
