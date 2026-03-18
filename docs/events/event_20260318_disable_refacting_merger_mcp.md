# Event: disable refacting-merger MCP

Date: 2026-03-18
Status: Done

## Request

- Disable the `refacting-merger` MCP in the active OpenCode runtime configuration.

## Scope

### In

- Disable the configured `refacting-merger` MCP entry for the local runtime.
- Verify the runtime config reflects the disabled state.
- Record the operation in the event ledger.

### Out

- No source-code behavior changes.
- No MCP package removal.
- No changes to capability registry snapshots in repo prompts/templates.

## Task List

- [x] Inspect architecture + current MCP routing baseline.
- [x] Confirm the active runtime config source.
- [x] Disable `refacting-merger` in runtime config.
- [x] Verify disabled state from system status and config file.
- [x] Record event + architecture sync result.

## Dialogue Summary

- User repeatedly requested: disable `refacting-merger` MCP.
- Action taken through runtime control-plane toggle, then verified against persisted config.

## Debug Checkpoints

### Baseline

- Symptom/Goal: `refacting-merger` should no longer be enabled in the local MCP runtime.
- Relevant boundary: runtime MCP config in `/home/pkcs12/.config/opencode/opencode.json`.

### Instrumentation Plan

- Check runtime-observed MCP state via system status.
- Inspect persisted config file to confirm the entry's `enabled` flag.

### Execution

- Runtime toggle executed for `refacting-merger` with `enabled=false`.
- Follow-up config read confirmed:
  - path: `/home/pkcs12/.config/opencode/opencode.json`
  - entry: `mcp.refacting-merger.enabled = false`

### Root Cause

- No bug RCA required; this was an explicit control-plane state change request.

### Validation

- Verified persisted config contains `"refacting-merger": { ..., "enabled": false }`.
- Verified enablement registry snapshot in repo already lists `refacting-merger` as disabled, so no repo doc/config sync was required.
- Architecture Sync: Verified (No doc changes).
  - Basis: `specs/architecture.md` already states MCP enable/disable remains config-driven; no architecture boundary changed.
