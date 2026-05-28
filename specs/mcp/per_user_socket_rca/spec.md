# Spec: MCP App per-user socket resolution

## Purpose

Make MCP App `url` resolution per-user-correct: layered registry merge plus URL template expansion so a system-declared MCP App reaches each user's own Unix socket without hand-editing config on every host.

## Requirements

### Requirement: Registry merge is layered, not system-wins

System tier owns app identity (`path`, `source`, `tools`, `settingsSchema`, `modelProcess`); user tier overrides runtime fields (`url`, `enabled`, `config`). Per OQ-1, `transport` is system-owned by default; revisit only with explicit decision.

#### Scenario: User overrides url for a system-declared app

- **GIVEN** `/etc/opencode/mcp-apps.json` declares app `docxmcp` with `url=unix:///stale/path:/mcp/`
- **AND** `~/.config/opencode/mcp-apps.json` declares the same `docxmcp` with `url=unix://${XDG_RUNTIME_DIR}/opencode/sockets/docxmcp/docxmcp.sock:/mcp/`
- **WHEN** `McpAppStore.loadConfig()` runs
- **THEN** the returned `docxmcp` entry carries the user-tier `url` template
- **AND** the system-tier `path` / `tools` / `settingsSchema` are preserved.

#### Scenario: User cannot override immutable system field

- **GIVEN** user-tier entry attempts to set `tools` or `path`
- **WHEN** `loadConfig()` merges
- **THEN** the immutable system fields win
- **AND** the merge does not raise — user-tier extras for immutable fields are dropped silently with a debug log.

### Requirement: Runtime URL templates expand inside the per-user daemon

`resolveRuntimeUrl(url, ctx)` expands `${UID}`, `${USER}`, `${HOME}`, `${XDG_RUNTIME_DIR}` using context derived from the per-user daemon process. `${XDG_RUNTIME_DIR}` falls back to `/run/user/${UID}` when env unset. Unknown `${...}` tokens are left intact for forward compatibility.

#### Scenario: Resolver expands all four tokens

- **GIVEN** input `unix://${XDG_RUNTIME_DIR}/opencode/sockets/docxmcp/docxmcp.sock:/mcp/` and context `{uid:1000, user:"pkcs12", home:"/home/pkcs12", xdgRuntimeDir:"/run/user/1000"}`
- **WHEN** `resolveRuntimeUrl()` runs
- **THEN** the output is `unix:///run/user/1000/opencode/sockets/docxmcp/docxmcp.sock:/mcp/`.

#### Scenario: Resolver uses process uid, not header-supplied uid

- **GIVEN** an inbound request header asserting a different uid
- **WHEN** the resolver runs inside the per-user daemon
- **THEN** the expansion uses `process.getuid()`, not header value.

### Requirement: Both MCP App URL consumers go through the resolver

`connectMcpApps()` in `mcp/index.ts` and the upload endpoint extraction in `incoming/dispatcher.ts` both call `resolveRuntimeUrl()` before opening the socket / forwarding HTTP.

#### Scenario: connectMcpApps dials the resolved socket

- **GIVEN** registry yields a templated `url`
- **WHEN** `connectMcpApps()` initialises the MCP App
- **THEN** the dialled socket path matches the resolver output, and MCP `initialize` returns `serverInfo.name=docxmcp`.

#### Scenario: dispatcher forwards uploads through the resolved endpoint

- **GIVEN** an HTTP upload request matches an MCP App route
- **WHEN** the dispatcher resolves the upload target
- **THEN** it uses the resolver output as the upstream endpoint and returns 200 for a smoke upload.

### Requirement: install_mcp_app supports explicit tier targeting

`system-manager_install_mcp_app` accepts optional `target: "system" | "user"` (default `system` for backward compatibility). The system-manager forwards `target` to `/mcp/store/apps`; the store persists to the matching tier only. `McpAppStoreError` surfaces the underlying cause (fs perm / JSON parse / schema validation).

#### Scenario: install with target=user writes to ~/.config only

- **GIVEN** `install_mcp_app({ target: "user", id: "foo", url: "..." })`
- **WHEN** the call completes
- **THEN** `~/.config/opencode/mcp-apps.json` carries the entry
- **AND** `/etc/opencode/mcp-apps.json` is unmodified.

## Invariants

- INV-1: Persisted `url` strings may contain template tokens; consumers MUST resolve before dialling — direct use of `.url` outside the resolver is a bug.
- INV-2: User tier never overrides system-immutable fields (`path`, `source`, `tools`, `settingsSchema`, `modelProcess`).
- INV-3: The resolver token catalogue is closed: only `${UID}`, `${USER}`, `${HOME}`, `${XDG_RUNTIME_DIR}` are expanded.
- INV-4: The daemon never writes to `/etc/opencode/*` at runtime.
- INV-5: Uid context comes from `process.getuid()`, not from request headers or client claims.

## Error Catalogue

- E-1: `mcp_app_url_unresolved` — resolver could not expand a required token (e.g. `${USER}` with empty env, no fallback applies).
- E-2: `mcp_app_user_override_rejected` — user-tier entry attempted to override an immutable system field; logged at debug, override silently dropped.
- E-3: `mcp_app_install_target_invalid` — `install_mcp_app` received `target` other than `system` / `user`.
- E-4: `mcp_app_install_failed` (replaces today's generic `McpAppStoreError`) — surfaces `cause: "fs_permission" | "json_parse" | "schema_validation" | "tier_conflict"`.

## Observability

- Each resolver call logs `{templatedUrl, resolvedUrl, appId}` at debug; production logs only carry the templated form to avoid host-identifying noise.
- `system-manager_list_mcp_apps` shows both `urlTemplate` and `urlResolved` per entry.
- Event log entry under `events/` captures merge change + first resolver wiring + docxmcp redeployment.

## Acceptance Checks

- [ ] AC-1: Unit tests cover layered merge for the four collision cases (system-only / user-only / runtime override / immutable-override-rejected).
- [ ] AC-2: Unit tests cover `resolveRuntimeUrl()` for each token in isolation, combined, and with `${XDG_RUNTIME_DIR}` fallback.
- [ ] AC-3: Integration test boots a per-user daemon against fixture mcp-apps.json files and observes the resolved socket dial; no mocks.
- [ ] AC-4: Post-rebuild smoke: `system-manager_list_mcp_apps` reports the resolved docxmcp URL; MCP `initialize` returns `serverInfo.name=docxmcp`.
- [ ] AC-5: Post-rebuild smoke: dispatcher HTTP upload to docxmcp returns 200.
- [ ] AC-6: `install_mcp_app({ target: "user" })` writes to `~/.config/opencode/mcp-apps.json` and `target: "system"` writes to `/etc/opencode/mcp-apps.json`; `McpAppStoreError` exposes `cause`.
- [ ] AC-7: With `/etc/opencode/mcp-apps.json` carrying the stale literal docxmcp URL, user-tier templated URL wins (no auto-migration; per DD-5 default).
