# Handoff

## Required reads

- `specs/architecture.md`
- `packages/mcp/system-manager/src/system-manager-session.ts`
- `packages/mcp/system-manager/src/index.ts`
- DB/session/message persistence implementation discovered during reconnaissance.

## Stop gates

- Stop if DB schema does not expose enough dialog data to preserve tool output contract.
- Stop if migration requires daemon/gateway restart; use `system-manager_restart_self` only with explicit need.
- Stop if validation would mutate non-backed-up XDG state.
