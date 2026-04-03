# Gmail MCP Background Token Refresh

Shared Google OAuth token refresh sweep on daemon startup.

## Status

IMPLEMENTED — all tasks completed 2026-04-02.
Commits: `1a130500e` (fix), `346a53925` (Gmail MCP fixes), `fcd7374b9` (initial feat).

## Key Decisions

- Refresh runs as background sweep at daemon startup, not a long-lived polling loop.
- Covers all shared Google token bindings (not Gmail-only).
- Concurrency guard prevents duplicate refresh races.

## Files

- [spec.md](spec.md) — requirements
- [design.md](design.md) — implementation design
