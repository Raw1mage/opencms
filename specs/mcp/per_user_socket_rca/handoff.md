# Handoff: mcp_per_user_socket_rca (registry contract hardening)

> Scope reframed 2026-05-28 — see `events/event_2026-05-28_scope-reframing.md`.

## Execution Contract

Harden the MCP App registry contract:

- Replace `system-wins` collision with layered merge (system identity + user runtime override).
- Introduce a forward-looking URL template resolver with closed token set and literal-passthrough.
- Add `target: "system" | "user"` to `install_mcp_app` and surface structured `cause` / `tier` on failure.

**Out of scope** (do not touch):

- docxmcp deployment — `docxmcp/mcp.json`, `docker-compose.yml`, `webctl.sh`, and the host-shared `.run/docxmcp.sock` path are out of scope. docxmcp's 2026-05-28 design is intentional and correct.
- MCP transport implementation (stdio / streamable-http / sse).
- The system tier (`/etc/opencode/mcp-apps.json`) — daemon never writes to it; layered merge handles stale entries.
- Resolver token catalogue widening beyond `${UID}` / `${USER}` / `${HOME}` / `${XDG_RUNTIME_DIR}`.
- `transport` field override (DD-4: system-owned).

## Required Reads

- `plans/mcp_per_user_socket_rca/proposal.md` — scope, open-question resolutions
- `plans/mcp_per_user_socket_rca/design.md` — DD-1..DD-8, code anchors, debug checkpoints
- `plans/mcp_per_user_socket_rca/spec.md` — requirements, invariants, AC-1..AC-7
- `plans/mcp_per_user_socket_rca/idef0.json`, `grafcet.json`, `sequence.json` — functional + runtime + interaction models
- `plans/mcp_per_user_socket_rca/data-schema.json` — entry / merged / resolver / install / error shapes
- `plans/mcp_per_user_socket_rca/rca.md` — original RCA evidence (do not overwrite)
- `packages/opencode/src/mcp/app-store.ts` (especially lines 21, 103, 266) — current merge + persistence
- `packages/opencode/src/mcp/index.ts` (~`:1283`) — `connectMcpApps()` consumer
- `packages/opencode/src/incoming/dispatcher.ts` (~`:206`) — HTTP upload consumer
- `packages/mcp/system-manager/src/index.ts` (~`:1848`) — `install_mcp_app` tool surface
- `packages/opencode/src/server/app.ts:136`, `packages/opencode/src/server/user-daemon/manager.ts:135` — per-user daemon context
- `/etc/opencode/mcp-apps.json`, `~/.config/opencode/mcp-apps.json` — current live tier files (READ to capture baseline)
- `docxmcp/mcp.json` and docxmcp Docker / webctl config — first consumer of the new contract
- `CLAUDE.md` — XDG backup whitelist + daemon lifecycle rules

## Environmental Preconditions

- Per-user daemon process exposes `process.getuid()`; current target is Linux only.
- `$XDG_RUNTIME_DIR` exists for the running user (fallback `/run/user/${UID}`).
- `aisecurity-sidecar` systemd user service is up if validation involves model calls (`systemctl --user status aisecurity-sidecar`).
- docxmcp container is healthy on the live socket before deployment alignment work begins.

## Stop Gates In Force

- **Stop** before the first code edit: XDG backup of `~/.config/opencode/*` per CLAUDE.md whitelist (`accounts.json`, `opencode.json`, `managed-apps.json`, `gauth.json`, `mcp.json`, `mcp-auth.json`, `openai-codex-accounts.json`, `models.json`, `providers.json`, `AGENTS.md`; plus legacy `~/.local/share/opencode/accounts.json` if present).
- **Stop** if the layered merge change would allow user tier to override an immutable system field (`path`, `source`, `tools`, `settingsSchema`, `modelProcess`). Drop the override silently with a debug log (E-2 in spec).
- **Stop** if the resolver attempts to expand a token outside the closed catalogue, or if uid comes from anywhere other than `process.getuid()`.
- **Stop** if validation requires daemon restart via shell `kill` / `systemctl restart opencode-gateway` / `bun ... serve`. Only path is `system-manager:restart_self` (or `webctl.sh restart` from source repo per `feedback_webctl_run_from_source_repo`).
- **Stop** if a rebuild fails — read the `restart_self` `errorLogPath`, fix root cause, do not bypass.
- **Stop** if integration tests resort to mocks for `McpAppStore` or socket dialling — per repo convention, integration tests must hit real filesystem + real socket.
- **Stop** if testing requires editing `/etc/opencode/*` from the daemon — daemon never writes to system tier (INV-4).
- **Stop** if the stale `/etc/opencode/mcp-apps.json` `docxmcp` entry is touched as part of automation — out-of-scope per DD-5.
- **Stop** if scope expands beyond docxmcp (e.g. trying to template URLs for stdio MCP Apps that don't have a socket path concern).

## Expected Output

- Minimal patch at the authoritative layer: `app-store.ts` (merge + structured error), new `mcp/url-resolver.ts`, two consumer call sites, `system-manager/src/index.ts` install schema, `server/routes/mcp.ts` error payload.
- Regression tests covering all 4 merge collision cases, token expansions including `${XDG_RUNTIME_DIR}` fallback, literal passthrough, and structured error classification.
- **No** changes to docxmcp deployment; `~/.config/opencode/mcp-apps.json` user-tier docxmcp entry stays as-is.
- Event log under `plans/mcp_per_user_socket_rca/events/`: scope-reframing entry (already written) + validation entry after Phase 6.
- `specs/architecture.md` MCP App registry section updated with the new layered semantics + resolver contract.
- `plan_advance` to `verified` once Phase 6 evidence is captured.

## Execution-Ready Checklist

- [x] XDG backup directory `~/.config/opencode.bak-20260528-2320-mcp-per-user-socket/` created.
- [x] Boundary diagnosis confirms `app-store.ts:103` is the authoritative merge site (also surfaced second merge site in `listApps()`; both fixed).
- [x] Resolver token catalogue committed as a closed enum, not a regex catch-all.
- [x] Both `connectMcpApps()` and `incoming/dispatcher.ts` upload path call the resolver.
- [x] Tests pass: 30 new tests across `app-store-merge.test.ts`, `url-resolver.test.ts`, `app-store-error.test.ts`; no regression on pre-existing failing tests.
- [ ] Smoke evidence (Phase 6): `system-manager:restart_self` (with user consent), `system-manager_list_mcp_apps` shows live URL, MCP `initialize` over docxmcp succeeds.
- [x] tasks.md checkboxes ticked via `spec_tick_task` as each task completed.
- [x] Scope-reframing event log written; validation event pending Phase 6.
