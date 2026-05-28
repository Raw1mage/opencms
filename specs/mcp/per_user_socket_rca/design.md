# Design: MCP App registry contract hardening

> Scope reframed 2026-05-28 from "per-user socket resolution" to "registry
> contract hardening". See `events/event_2026-05-28_scope-reframing.md`.
> Folder slug `mcp_per_user_socket_rca` retained for history continuity;
> the user-facing narrative inside this package is what carries the new
> framing.

## Context

`McpAppStore` has two tiers: system (`/etc/opencode/mcp-apps.json`) and user (`~/.config/opencode/mcp-apps.json`). The merge `{ ...user.apps, ...system.apps }` at `packages/opencode/src/mcp/app-store.ts:103` makes system tier shadow user tier on id collision — explicitly documented at `app-store.ts:21` as the intentional rule.

Two consumers read this merged view:

1. `packages/opencode/src/mcp/index.ts:1283` — `connectMcpApps()` calls `McpAppStore.loadConfig()` then dials each app's `url`.
2. `packages/opencode/src/incoming/dispatcher.ts:206` — looks up the MCP App's `url` to route HTTP file uploads.

Stored `url` is a literal string. `app-store.ts:266` persists `manifest.url` verbatim from `install_mcp_app` payloads. No part of the load/consume path expands templating.

`McpAppStoreError` collapses every failure into a generic `{ operation, reason }` shape — operators cannot tell whether a failure was filesystem permission, JSON corruption, schema validation, or tier mismatch without reading code.

The empirical trigger that surfaced these bugs was a docxmcp socket misroute, but docxmcp itself made a deliberate 2026-05-28 decision to use a host-shared socket at `./.run/docxmcp.sock` (rootful Docker namespace cannot reach `/run/user/<uid>/`). That decision is correct in docxmcp's domain and is out of scope here; this plan addresses the registry contract bugs the trigger exposed.

## Goals / Non-Goals

Goals:

- One canonical URL template that any user/host can use unmodified for a per-user socket MCP App.
- Layered merge that lets the user tier override `url`, `enabled`, `config` (and possibly `transport`, see OQ-1) without losing system-tier identity (path, tools, schema, source).
- One resolver used by every MCP App URL consumer; no ad-hoc expansion sprinkled around.

Non-goals:

- No replacement of the MCP transport implementation.
- No removal of the system tier; system-tier `mcp-apps.json` stays useful for app discovery.
- No daemon-side automatic rewrite of `/etc/opencode/mcp-apps.json` (see OQ-2 default).
- No multi-user auth model; the per-user daemon already owns its uid.

## Boundaries

- Schema boundary: `McpAppStore` persisted `url` may contain template tokens; on disk it is still a single string. Consumers MUST go through the resolver.
- Resolver boundary: token set is closed — `${UID}`, `${USER}`, `${HOME}`, `${XDG_RUNTIME_DIR}`. No environment-variable passthrough; no arbitrary `${ENV.*}` expansion.
- Privilege boundary: `process.getuid()` (or equivalent on the active daemon) is the only uid source. Any header-derived uid is rejected.
- Merge boundary: user tier overrides only `url`, `enabled`, `config`, (conditionally) `transport`. All other fields are system-owned.

## Decisions

- **DD-1**: Replace `system-wins` collision with `layered merge`. System tier owns immutable identity fields (`path`, `source`, `tools`, `settingsSchema`, `modelProcess`); user tier overrides runtime fields. Rationale: per-user runtime endpoint is a user-tier concern by definition; conflating it with system identity makes per-machine deployment impossible.
- **DD-2**: Introduce `resolveRuntimeUrl(url: string, ctx: { uid: number; user: string; home: string; xdgRuntimeDir: string }): string` in `packages/opencode/src/mcp/url-resolver.ts`. Token set is closed: `${UID}`, `${USER}`, `${HOME}`, `${XDG_RUNTIME_DIR}` (latter defaults to `/run/user/${UID}` when env unset). **Literal-passthrough is intentional** — a URL with no template tokens is returned unchanged. The resolver is a forward-looking utility for future MCP Apps that legitimately want per-machine-portable paths; it imposes no template requirement on existing apps (docxmcp included). Rationale: closed token set is auditable and unambiguous; arbitrary env passthrough invites supply-chain footguns.
- **DD-3**: Resolver is called at the consumption site, not at persistence time. Persisted `url` keeps template literals; `connectMcpApps()` and `incoming/dispatcher.ts` resolve at dial time. Rationale: a config written on host A must remain meaningful on host B; resolving-at-persist would freeze the wrong values.
- **DD-4** (confirmed 2026-05-28, OQ-1 resolved): User tier may override `url`, `enabled`, `config` only. `transport` stays system-owned. Rationale: transport drift between tiers creates "tool exists but never executes" failures that are hard to RCA; the cost of revisiting later (a `revise`) is lower than the cost of one production incident. Reconsider if multi-app deployment evidence demonstrates a concrete need.
- **DD-5** (confirmed 2026-05-28, OQ-2 resolved): The stale `/etc/opencode/mcp-apps.json` `docxmcp` entry is not auto-migrated. The new layered merge makes the stale URL dead text; the daemon does not edit `/etc/opencode/*` at runtime. Rationale: writing system-tier files from the per-user daemon crosses the privilege boundary; layered merge already removes the operational symptom. Reconsider only if the stale entry becomes operationally confusing.
- **DD-6** (reinterpreted 2026-05-28 after scope reframing — see `events/event_2026-05-28_scope-reframing.md`): docxmcp's `.run/docxmcp.sock` is **canonical**, not a dev fallback. Per docxmcp's own 2026-05-28 decision, the rootful Docker daemon's mount namespace cannot reach `/run/user/<uid>/...`, so docxmcp deliberately uses a repo-local IPC rendezvous bound at 0666 with directory at 0755 — host-shared by design. This plan does not modify docxmcp's socket path or any deployment config. The URL resolver from DD-2 still handles the path: a literal URL with no template tokens passes through untouched. Rationale: each downstream MCP App owns its own deployment contract; the registry's job is to be flexible enough to express either path shape.
- **DD-7**: `system-manager_install_mcp_app` gains an optional `target: "system" | "user"` parameter (default `system` to preserve current behaviour). The tool routes to `/mcp/store/apps?target=<v>` so automation can register a user-tier override intentionally. Rationale: today there is no programmatic way to install a user-tier app; users must hand-edit `~/.config/opencode/mcp-apps.json`.
- **DD-8**: `McpAppStoreError` surfaces the underlying cause (filesystem permission, JSON parse, schema validation) instead of collapsing to a generic `install failed`. Rationale: install failures in production today require code-reading to diagnose; cheap to fix once.

## Debug Checkpoints

- CP-1: `McpAppStore.loadConfig()` returns a docxmcp entry whose `url` literal is the templated form `unix://${XDG_RUNTIME_DIR}/opencode/sockets/docxmcp/docxmcp.sock:/mcp/`.
- CP-2: `resolveRuntimeUrl()` expands that to `unix:///run/user/1000/opencode/sockets/docxmcp/docxmcp.sock:/mcp/` inside the per-user daemon (uid=1000 on this machine).
- CP-3: `connectMcpApps()` dials the resolved socket; MCP `initialize` returns `serverInfo.name=docxmcp`.
- CP-4: `incoming/dispatcher.ts` HTTP upload routes to the same resolved endpoint and 200s on a smoke upload.
- CP-5: With `/etc/opencode/mcp-apps.json` carrying a stale literal URL and `~/.config/opencode/mcp-apps.json` carrying the templated override, layered merge wins and CP-1..CP-4 still pass.
- CP-6: `system-manager_install_mcp_app({ target: "user", ... })` writes to `~/.config/opencode/mcp-apps.json` only and a subsequent `loadConfig()` reflects the install.

## Validation Plan

- **Unit**: `McpAppStore.loadConfig()` table-driven test covering (a) system-only app, (b) user-only app, (c) collision with user `url` override, (d) collision attempting to override an immutable field (must be dropped).
- **Unit**: `resolveRuntimeUrl()` with each token in isolation and combined; unknown tokens left intact; `${XDG_RUNTIME_DIR}` fallback to `/run/user/${UID}` when env unset.
- **Integration**: per-user daemon spin-up against fixture `mcp-apps.json` files (system + user) hits a fixture HTTP-over-unix server through the resolver.
- **Smoke (manual, post-rebuild)**: `system-manager:restart_self` → check `system-manager_list_mcp_apps` reports the resolved URL → MCP `initialize` over the docxmcp socket succeeds → smoke document upload via dispatcher succeeds.
- **No mocks** for the integration test path (per repo convention; integration tests must hit a real socket, not a fake).

## Risks / Trade-offs

- **Merge semantic change is observable**: any operator currently relying on `/etc/opencode/mcp-apps.json` to override user-tier configuration loses that ability. Mitigation: document in event log + ensure the layered-merge semantics are stated explicitly in `app-store.ts` header comment.
- **Template tokens in stored URLs leak into telemetry**: any log line that prints `url` literally will show the templated form. This is desirable (it identifies the app config, not the host) but cosmetically different. Mitigation: include both literal and resolved form in MCP App debug logs.
- **`process.getuid()` availability**: Bun runtime exposes this on Linux; mac/Windows paths are out of scope for now. If OpenCMS adds non-Linux daemons later, the resolver must be widened.
- **OQ-1 / OQ-2 / OQ-3 deferral**: design ships with defaults; if defaults turn out wrong, revise instead of amend (scope-level change).

## Critical Files

- `packages/opencode/src/mcp/app-store.ts` — merge policy (`loadConfig`, persistence at `:266`).
- `packages/opencode/src/mcp/url-resolver.ts` (NEW) — `resolveRuntimeUrl()` + closed-token catalogue.
- `packages/opencode/src/mcp/index.ts` (around `:1283`) — wire resolver into `connectMcpApps()`.
- `packages/opencode/src/incoming/dispatcher.ts` (around `:206`) — wire resolver into HTTP upload endpoint extraction.
- `packages/mcp/system-manager/src/index.ts` (around `:1848`) — `install_mcp_app` schema + error propagation.
- `/etc/opencode/mcp-apps.json`, `~/.config/opencode/mcp-apps.json` — operational tiers (no schema change, semantic change).
- `docxmcp/mcp.json` and docxmcp Docker / webctl wiring — first consumer of the templated URL.

## Code Anchors

- `packages/opencode/src/mcp/app-store.ts:21` — current `system-level wins on id collision` doc comment (must be rewritten).
- `packages/opencode/src/mcp/app-store.ts:103` — current `{ ...user.apps, ...system.apps }` merge.
- `packages/opencode/src/mcp/app-store.ts:266` — persistence of `manifest.url`.
- `packages/opencode/src/mcp/index.ts:1283` — `McpAppStore.loadConfig()` consumer in `connectMcpApps()`.
- `packages/opencode/src/incoming/dispatcher.ts:206` — `McpAppStore.loadConfig()` consumer in dispatcher upload path.
- `packages/mcp/system-manager/src/index.ts:1848` — `install_mcp_app` tool surface.
- `packages/opencode/src/server/app.ts:136` — per-user daemon ownership context.
- `packages/opencode/src/server/user-daemon/manager.ts:135` — per-user `/run/user/<uid>` socket pattern.
