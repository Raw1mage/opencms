# Event 2026-05-23 — specbase MCP session-list flood hotfix

## Scope

- RCA and hotfix for specbase-related local MCP startup mislaunch creating AI-run session artifacts.
- Prevent session catalog refresh amplification from filesystem touches under session storage.
- Update MCP and session specs so local stdio MCP process boundaries and catalog refresh rules are explicit.

## Root Cause

- Local MCP startup accepted raw commands without a per-entry `cwd`, so a config such as `bun run /home/pkcs12/projects/specbase/packages/mcp/src/index.ts` ran from the opencode repo directory.
- The malformed child printed OpenCMS runtime fingerprints and timed out as an MCP server, but the runtime only reported a generic MCP startup timeout.
- `session-storage-watch` treated any top-level `ses_*` filesystem event as catalog invalidation and published `global.disposed`; frontend global sync interpreted that as a root session-list revalidate.
- LSP/tool file touches of `storage/session/<sid>/info.json` therefore amplified into repeated session-list refreshes when multiple watcher processes were present.

## Changes

- `McpLocalConfig` now accepts `cwd` for explicit local MCP working-directory control.
- Local stdio MCP startup fails fast if stderr shows AI-runtime fingerprints (`[opencode]`, `session.request.identity.selected`).
- `session-storage-watch` now accepts only top-level `rename` events for `ses_*` entries; content `change` events are ignored.
- Local `~/.config/opencode/mcp.json` specbase entry now runs `bun packages/mcp/src/index.ts` with `cwd=/home/pkcs12/projects/specbase` and `SPECBASE_TARGET_REPO=/home/pkcs12/projects/opencode`.

## Validation

- `bun test packages/opencode/src/server/session-storage-watch.test.ts` passed: 3 tests, 8 assertions.
- `bun run typecheck` passed for SDK, plugin, UI, opencode, app, and util workspaces.
- Runtime restart/live MCP reconnect remains pending; use controlled `restart_self` before confirming the deployed daemon behavior.

## Architecture Sync

- Updated `specs/architecture.md` with catalog-only session-list refresh and local MCP mislaunch guard.
- Updated `specs/mcp/README.md` and `specs/mcp/datasheet.md` with local stdio `cwd` and fail-fast boundary.
- Updated `specs/session/README.md` with the `session-storage-watch` catalog refresh invariant.
