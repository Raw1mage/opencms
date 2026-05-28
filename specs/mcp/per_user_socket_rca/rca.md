# RCA Plan — MCP App per-user socket resolution

## Summary

`docxmcp` is running and reachable on its current Unix socket, but OpenCMS / OpenCode can still resolve the MCP App through a stale system-level registry entry. The current MCP App Store merge rule makes `/etc/opencode/mcp-apps.json` override `~/.config/opencode/mcp-apps.json`, so a per-user socket override cannot take effect when the same app id exists in both tiers.

## Symptom

- `docxmcp` Docker container is healthy.
- `curl --unix-socket /home/pkcs12/projects/docxmcp/.run/docxmcp.sock http://docxmcp.local/healthz` succeeds.
- Direct MCP `initialize` against `/mcp/` over that socket succeeds.
- `system-manager_list_mcp_apps` still reports the system-level `docxmcp` app because the system tier wins on id collision.
- `/etc/opencode/mcp-apps.json` still points `docxmcp.url` at the old `/run/user/1000/opencode/sockets/docxmcp/docxmcp.sock` path.

## Evidence

- `packages/opencode/src/mcp/app-store.ts:21` documents `system-level wins on id collision`.
- `packages/opencode/src/mcp/app-store.ts:103` merges config as `{ ...user.apps, ...system.apps }`.
- `packages/opencode/src/mcp/index.ts:1283` calls `McpAppStore.loadConfig()` before connecting enabled MCP Apps.
- `packages/opencode/src/incoming/dispatcher.ts:206` uses `McpAppStore.loadConfig()` for MCP App HTTP upload endpoint resolution.
- `packages/opencode/src/mcp/app-store.ts:266` persists `manifest.url` directly for streamable HTTP Apps; it does not expand `${UID}`, `${USER}`, `${HOME}`, or `${XDG_RUNTIME_DIR}` at runtime.
- `packages/mcp/system-manager/src/index.ts:1848` exposes `install_mcp_app` without a user/system target parameter, so automation defaults to system registration.
- `packages/opencode/src/server/app.ts:136` and `packages/opencode/src/server/user-daemon/manager.ts:135` show OpenCMS is designed around per-user daemon ownership and `/run/user/<uid>` sockets.

## Root Cause

The MCP App registry conflates two concerns:

1. **System app availability** — `/etc/opencode/mcp-apps.json` says an app exists for all users.
2. **Per-user runtime endpoint** — a Unix socket path is user-specific and must resolve inside the per-user daemon context.

Because system-level entries override user-level entries, users cannot override a stale or generic system endpoint with their own socket path. Because stored URLs are static strings, a system-level entry cannot express a portable per-user socket endpoint safely.

## Required Design Change

Treat MCP App metadata and MCP App runtime endpoints as separate layers:

- System tier may define app identity, path, manifest metadata, and default availability.
- User tier must be able to override user-specific fields: `url`, `enabled`, and `config`.
- Runtime must expand socket variables in the daemon process that is actually serving the user.

## Proposed Fix

### F1 — Merge policy

Change `McpAppStore.loadConfig()` from `system wins` to a layered merge:

- Preserve system-only apps.
- Preserve user-only apps.
- On id collision, keep system immutable fields (`path`, `source`, `tools`, `settingsSchema`, `modelProcess`) unless user explicitly installs a full user app.
- Let user-specific fields override system defaults: `enabled`, `config`, `url`, and possibly `transport` for HTTP Apps.

### F2 — Runtime URL template expansion

Add one resolver, used by all MCP App HTTP consumers:

- `${UID}` → `process.getuid()` in the per-user daemon.
- `${USER}` → `os.userInfo().username` or `process.env.USER`.
- `${HOME}` → `os.homedir()`.
- `${XDG_RUNTIME_DIR}` → `process.env.XDG_RUNTIME_DIR ?? /run/user/${UID}`.

Use this resolver before `MCP.add()` in `connectMcpApps()` and before upload endpoint extraction in `incoming/dispatcher.ts`.

### F3 — Manifest / registry contract

Make `docxmcp` use a portable URL in `mcp.json`:

```json
"url": "unix://${XDG_RUNTIME_DIR}/opencode/sockets/docxmcp/docxmcp.sock:/mcp/"
```

Do not hard-code `/run/user/1000` or repo-local `.run` in long-lived registry entries.

### F4 — System-manager target control

Expose `target: "system" | "user"` in `system-manager_install_mcp_app`, passing it through to `/mcp/store/apps` so automation can intentionally register per-user overrides.

### F5 — Deployment alignment

Align docxmcp Docker / webctl socket location with the per-user runtime contract:

- Preferred host path: `$XDG_RUNTIME_DIR/opencode/sockets/docxmcp/docxmcp.sock`.
- Repo-local `.run/docxmcp.sock` may remain a dev fallback only if documented as non-authoritative.

## Out of Scope

- Replacing MCP transport implementation.
- Restarting OpenCMS / gateway from shell.
- Changing docxmcp tool semantics.
- Removing system-level app registry entirely.

## Validation Plan

- Unit test `McpAppStore.loadConfig()` collision behavior: user `url/enabled/config` override system defaults.
- Unit test URL expansion for `${UID}`, `${USER}`, `${HOME}`, `${XDG_RUNTIME_DIR}`.
- Integration smoke: system registry contains docxmcp with templated URL; per-user daemon resolves to that user's socket.
- Integration smoke: user-level override beats system-level stale URL.
- MCP smoke: `initialize` over resolved `unix://...:/mcp/` returns `serverInfo.name=docxmcp`.
- Upload smoke: dispatcher HTTP file upload resolves the same per-user endpoint.

## Stop Gates

- Stop if changing merge policy would allow user entries to override security-sensitive system fields unexpectedly.
- Stop if per-user daemon lacks reliable `XDG_RUNTIME_DIR` / uid context.
- Stop if docxmcp deployment cannot create the target socket directory without violating bind-mount policy.

## Expected Outcome

OpenCMS can remain a system-level service while each authenticated user connects to their own MCP App Unix socket. System registry remains useful for app discovery, and user/runtime state owns the actual per-user endpoint.
