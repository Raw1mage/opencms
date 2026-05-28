## Why

- The MCP App registry today has a load-bearing bug: `McpAppStore.loadConfig()` at [app-store.ts:103](packages/opencode/src/mcp/app-store.ts#L103) merges as `{ ...user.apps, ...system.apps }`, making system-tier entries silently shadow user-tier entries on id collision. That means a user can never override runtime fields (`url`, `enabled`, `config`) for any system-declared MCP App on their own machine — the registry behaves as if the user tier doesn't exist when the system tier has the same id.
- `system-manager_install_mcp_app` cannot target the user tier; it always writes to `/etc/opencode/mcp-apps.json` via sudo. There is no programmatic way to register a user-tier override; the only path is hand-editing JSON.
- `McpAppStoreError` collapses every failure into a generic `{ operation, reason }` shape. Operators reading the install failure cannot tell whether the cause was filesystem permission, JSON corruption, schema validation, or tier mismatch. Diagnosis today requires reading code.
- Stored `url` values are static strings; no part of the registry consumer path expands templating. Any future MCP App that wants a per-machine-portable URL (e.g. `${HOME}` or `${UID}` in the path) has no mechanism to express it.
- The empirical trigger that surfaced the bug was a docxmcp socket misroute, but the bug is in the registry contract, not in docxmcp. See `events/event_2026-05-28_scope-reframing.md` for why the original "per-user socket" framing was discarded.

## Original Requirement Wording (Baseline)

- "處理/plans/rca plan"
- Inline expansion (2026-05-28): promote the existing `rca.md` + `tasks.md` skeleton into a full plan-builder package; surface the three open decisions instead of silently picking defaults.

## Requirement Revision History

- 2026-05-28: legacy `rca.md` + `tasks.md` folder created.
- 2026-05-28: promoted to plan-builder package; OQ-1/2/3 resolved.
- 2026-05-28: scope reframed from "per-user socket resolution" to "MCP App registry contract hardening" after Phase 5 surfaced docxmcp's deliberate counter-design. See `events/event_2026-05-28_scope-reframing.md`.

## Effective Requirement Description

1. Replace the `system-wins` merge in `McpAppStore.loadConfig()` with a layered merge: system tier owns app identity (`path`, `command`, `source`, `tools`, `settingsSchema`, `modelProcess`, `installedAt`, `transport`); user tier overrides runtime fields (`url`, `enabled`, `config`). Same change applies to `listApps()`.
2. Introduce a URL-template resolver (`${UID}` / `${USER}` / `${HOME}` / `${XDG_RUNTIME_DIR}`) used by every MCP App URL consumer. A literal URL with no tokens is a no-op pass-through; this gives any future MCP App that wants per-machine-portable URLs a mechanism without forcing it on apps that don't.
3. Expose `target: "system" | "user"` on `system-manager_install_mcp_app` so automation can register a user-tier entry without hand-editing JSON.
4. Extend `McpAppStoreError` with structured `cause` (`fs_permission` | `json_parse` | `schema_validation` | `tier_conflict` | `unknown`) and `tier` so install failures surface the real reason.
5. **Verify** (not migrate) docxmcp's existing user-tier entry is correct under the new merge; do not change docxmcp's mcp.json, Docker config, or socket path. docxmcp's host-shared `.run/docxmcp.sock` is its own canonical design per the docxmcp 2026-05-28 decision.

## Scope

### IN

- `packages/opencode/src/mcp/app-store.ts` — merge policy + structured error type.
- `packages/opencode/src/mcp/url-resolver.ts` (NEW) — closed-token URL template expansion.
- `packages/opencode/src/mcp/index.ts` (~`:1283`) — resolver wiring in `connectMcpApps()`.
- `packages/opencode/src/incoming/dispatcher.ts` (~`:206`) — resolver wiring in HTTP upload route.
- `packages/mcp/system-manager/src/index.ts` (~`:1848`) — `install_mcp_app` schema + structured error surfacing.
- `packages/opencode/src/server/routes/mcp.ts` (~`:867`) — POST `/mcp/store/apps` returns `cause` / `tier` fields when `StoreError` is thrown.
- Unit tests for merge collisions, URL expansion, structured error classification.
- Verification that user-tier docxmcp entry remains routable after the merge change.

### OUT

- Any change to docxmcp's `mcp.json`, `docker-compose.yml`, `webctl.sh`, or socket path. docxmcp's 2026-05-28 design (host-shared socket via `.run/`) is out of scope.
- Replacing the MCP transport layer (stdio / streamable-http / sse).
- Auto-migrating or rewriting `/etc/opencode/mcp-apps.json` from within the daemon.
- Multi-user authorization model — the per-user daemon already owns its uid context, and docxmcp explicitly chose host-shared access anyway.
- Daemon restart automation; rebuild + `system-manager:restart_self` only (per CLAUDE.md).

## Non-Goals

- This plan does not deliver "per-user socket isolation". For docxmcp specifically, the socket is host-shared by design.
- The URL resolver does not force any existing app to adopt templated URLs; literal URLs pass through unchanged.

## Constraints

- Layered merge must not let user-tier overrides escalate privilege or change system-immutable identity fields.
- URL resolver token catalogue is **closed** — only `${UID}` / `${USER}` / `${HOME}` / `${XDG_RUNTIME_DIR}` are expanded; unknown `${...}` left intact for forward compatibility.
- uid context for the resolver MUST come from `process.getuid()`, never from request headers or client claims (INV-5).
- XDG backup of `~/.config/opencode/*` before first code edit per CLAUDE.md whitelist. (Done 2026-05-28.)
- Daemon lifecycle: rebuild + `system-manager:restart_self` only; no shell `kill` / `systemctl restart` / `bun ... serve`.

## Open Questions (resolved 2026-05-28)

All three open questions were closed by the user accepting the default-if-undecided positions; DD-4 / DD-5 / DD-6 in design.md are confirmed (DD-6 with the post-reframing reinterpretation; see design.md).

### OQ-1 — Should user-tier override be allowed to change `transport`? — RESOLVED: no

Keep `transport` system-owned. User tier may override only `url`, `enabled`, `config`. See [DD-4](design.md).

### OQ-2 — Should the stale system-tier entries be auto-migrated? — RESOLVED: no

Layered merge already neutralises stale system-tier entries; daemon does not edit `/etc/opencode/*` at runtime. See [DD-5](design.md).

### OQ-3 — Should repo-local `.run/docxmcp.sock` be removed? — RESOLVED: it is canonical for docxmcp, not fallback

Reframed 2026-05-28: `.run/docxmcp.sock` is docxmcp's authoritative IPC path (per docxmcp's own 2026-05-28 decision regarding rootful docker namespace). This plan does not touch docxmcp's deployment. See [DD-6](design.md).

## What Changes

- `packages/opencode/src/mcp/app-store.ts`: replace `system-wins` collision rule with layered merge; extract pure `mergeAppsConfigs()`; extend `StoreError` with structured `cause` + `tier`; `listApps()` uses the same merge.
- `packages/opencode/src/mcp/url-resolver.ts` (NEW): closed-token resolver for `${UID}` / `${USER}` / `${HOME}` / `${XDG_RUNTIME_DIR}` with literal-passthrough semantics.
- `packages/opencode/src/mcp/index.ts` (~`:1283`) and `packages/opencode/src/incoming/dispatcher.ts` (~`:206`): pass `url` through the resolver before dialing.
- `packages/mcp/system-manager/src/index.ts` (~`:775`): `install_mcp_app` gains `target: "system" | "user"`; surfaces `cause` and `tier` in failure text.
- `packages/opencode/src/server/routes/mcp.ts` (~`:867`): POST `/mcp/store/apps` returns structured `cause` / `tier` when `StoreError` is thrown.

## Capabilities

### New Capabilities

- Per-user runtime overrides on system-declared MCP Apps (currently impossible).
- Programmatic install into user tier via `install_mcp_app({ target: "user" })`.
- Forward-looking URL template resolution for any future MCP App that wants per-machine-portable paths.

### Modified Capabilities

- `McpAppStore.loadConfig()` — layered merge replaces system-wins.
- `McpAppStore.listApps()` — same layered semantics; `tier` reflects identity origin.
- `McpAppStoreError` — gains structured `cause` + `tier`.

## Impact

- Affected code: see "What Changes".
- Affected users: OpenCMS users editing `~/.config/opencode/mcp-apps.json` to override system-declared apps (today: 0 such users, since the override didn't work; tomorrow: enabled).
- Affected operators: anyone editing `/etc/opencode/mcp-apps.json` by hand — semantics change from "wins by default" to "wins for app identity, loses for runtime endpoint".
- Not affected: docxmcp deployment, docxmcp socket path, current docxmcp user-tier entry — all stay as-is.
