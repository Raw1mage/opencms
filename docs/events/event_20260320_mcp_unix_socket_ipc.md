# Event: MCP Server Unix Socket IPC + Auto-detection + Startup Optimization

**Date**: 2026-03-20
**Scope**: MCP server ↔ opencode communication, MCP mode auto-detection, webctl compile-mcp, npx elimination

---

## Requirement

MCP servers (system-manager etc.) communicate with the opencode daemon via HTTP, which fails in TUI mode (no web server). User requested a fundamental fix: use unix socket IPC instead of HTTP.

## Scope

### IN
- system-manager: unix socket IPC via `serverFetch()` wrapper
- config.ts: auto-detect source repo (no env var dependency for MCP mode)
- webctl.sh: `compile-mcp` command + staleness-based auto-recompile
- enablement.json: register `set_log_level` tool
- Removed `OPENCODE_INTERNAL_MCP_MODE="source"` from webctl.sh (auto-detected now)

### OUT
- Other MCP servers (refacting-merger, gcp-grounding) — unix socket changes only in system-manager
- Daemon auto-restart on code changes (manual restart required after code updates)

## Key Decisions

1. **Unix socket over HTTP**: MCP servers use `getDaemonSocketPath()` → `/run/user/<uid>/opencode/daemon.sock`, same path as `server/daemon.ts`
2. **`serverFetch()` wrapper**: Checks socket existence, adds `{ unix: sock }` to fetch options. Transparent fallback to regular HTTP when socket absent.
3. **Repo auto-detection**: `detectRepoRoot()` in config.ts uses `import.meta.url` to locate source tree, eliminating env var dependency for MCP source mode.
4. **No env-based MCP mode control**: User explicitly rejected `OPENCODE_INTERNAL_MCP_MODE` env var approach. Auto-detection is the only path.

## Debug Checkpoints

### Baseline
- Symptom: `set_log_level` tool returns 503 via daemon socket
- Reproduction: Start TUI session, wait for system-manager MCP, invoke `set_log_level action=get`

### Root Cause
- The 503 was from the **frontend catch-all** (`app.get("/*")`) in app.ts, returning `FRONTEND_BUNDLE_MISSING`
- The `/global/log-level` route was **not registered** because the daemon process was started (Mar 19 21:55) **before** the bus merge commit (Mar 20 00:19) that added the route
- `bun` does not hot-reload; daemon must be restarted to pick up new routes
- Confirmed: other GlobalRoutes GET endpoints (health, auth/session, config) worked; only log-level failed because it was added in the later commit

### Validation
- `curl --unix-socket daemon.sock http://localhost/api/v2/global/log-level` → `{"level":2,"name":"normal"}` ✓
- `curl -X POST -d '{"level":1}' ...` → `{"level":1,"name":"quiet"}` ✓
- All other API routes continue to work via unix socket ✓

## Phase 2: MCP Startup Optimization (npx elimination)

### Baseline
- 4 out of 5 enabled MCP servers used `npx -y` to launch
- `npx -y` takes ~10.8 seconds per server (npm cache check, resolve, link, node startup)
- Total MCP startup: 90-120 seconds (sequential), heavy CPU burn

### Root Cause
- `npx -y` is designed for one-off CLI invocation, not per-session high-frequency startup
- Each invocation: registry resolve → cache verify → extract → link → spawn node

### Fix
- Installed 4 MCP packages as project devDependencies (`bun add -d`)
- Updated `~/.config/opencode/opencode.json`: replaced `npx -y <pkg>` with `bun <node_modules/.../dist/index.js>`
- Direct bun execution: ~0.35s per server (30x faster)

### Packages migrated
| Package | Old command | New command |
|---------|-----------|-------------|
| server-filesystem | `npx -y @modelcontextprotocol/server-filesystem` | `bun node_modules/@modelcontextprotocol/server-filesystem/dist/index.js` |
| mcp-server-fetch-typescript | `npx -y mcp-server-fetch-typescript` | `bun node_modules/mcp-server-fetch-typescript/build/index.js` |
| server-memory | `npx -y @modelcontextprotocol/server-memory` | `bun node_modules/@modelcontextprotocol/server-memory/dist/index.js` |
| server-sequential-thinking | `npx -y @modelcontextprotocol/server-sequential-thinking` | `bun node_modules/@modelcontextprotocol/server-sequential-thinking/dist/index.js` |

### Validation
- All 4 servers respond to JSON-RPC `initialize` via bun direct execution ✓
- Benchmark: 0.35s vs 10.8s per server ✓

## Remaining

- Other MCP servers don't have `serverFetch()` yet (system-manager only)
- Daemon has no auto-restart mechanism after code changes
- Architecture Sync: TBD (pending commit)
