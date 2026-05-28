# Tasks — MCP App registry contract hardening

> Slug folder remains `mcp_per_user_socket_rca` for history continuity.
> Scope reframed 2026-05-28 — see `events/event_2026-05-28_scope-reframing.md`.

## Phase 0 — Evidence and scope (carried from rca.md)

- [x] Confirm docxmcp socket is live and MCP initialize works over current socket.
- [x] Confirm registry merge bug: user-tier override ignored when system tier has same id.
- [x] Identify all code paths that read `McpAppStore.loadConfig()` for MCP App endpoint selection.
- [x] Promote `/plans/mcp_per_user_socket_rca/` into plan-builder package (proposal/design/idef0/grafcet authored).
- [x] Discovery 2026-05-28: docxmcp socket is intentionally host-shared (not per-user); plan reframed accordingly.

## Phase 1 — Resolve open questions

- [x] OQ-1: confirm DD-4 (transport overridability). Resolved: **no** — keep `transport` system-owned.
- [x] OQ-2: confirm DD-5 (auto-migrate stale system entry). Resolved: **no** — layered merge neutralises stale entries.
- [x] OQ-3: confirm DD-6. Resolved with reinterpretation: docxmcp's `.run/docxmcp.sock` is **canonical** for docxmcp per its 2026-05-28 design; this plan does not touch docxmcp deployment.

## Phase 2 — Registry merge semantics

- [x] Author table-driven tests for current `system-wins` behaviour (regression baseline).
- [x] Replace `system-wins` merge in `McpAppStore.loadConfig()` with layered merge per DD-1 (extracted to pure `mergeAppsConfigs()`).
- [x] Update header comment at `app-store.ts:21` to state new semantics.
- [x] Document which fields are system-owned vs user-overridable in JSDoc on `McpAppStore.loadConfig`.
- [x] Apply the same merge to `listApps()` (second merge site at the old `:491`).

## Phase 3 — Runtime URL resolver (forward-looking utility)

- [x] Add `packages/opencode/src/mcp/url-resolver.ts` with `resolveRuntimeUrl(url, ctx)`.
- [x] Support `${UID}`, `${USER}`, `${HOME}`, `${XDG_RUNTIME_DIR}` (latter falls back to `/run/user/${UID}`).
- [x] Wire resolver into `connectMcpApps()` before `MCP.add()`.
- [x] Wire resolver into `incoming/dispatcher.ts` before HTTP upload endpoint extraction.
- [x] Add unit tests for each token in isolation and combined; literal URLs pass through untouched; unknown tokens preserved.

## Phase 4 — system-manager install target + structured error

- [x] Add `target?: "system" | "user"` to `install_mcp_app` schema.
- [x] Pass `target` through to `/mcp/store/apps` install request (server route already accepted it).
- [x] Extend `McpAppStoreError` with structured `cause` (`fs_permission` | `json_parse` | `schema_validation` | `tier_conflict` | `unknown`) and `tier`.
- [x] Surface `cause` / `tier` in server route response body and in system-manager tool output.
- [x] Add `classifyStoreError()` helper + tests covering all five cause classes.

## Phase 5 — Verify docxmcp routing under the new merge (no deployment edits)

> docxmcp's deployment is intentionally host-shared and out of scope for this plan.
> This phase verifies that the existing user-tier entry still routes correctly
> under the new layered merge — no edits to docxmcp's mcp.json, docker-compose,
> webctl, or socket path.

- [x] XDG backup before first edit (done at `~/.config/opencode.bak-20260528-2320-mcp-per-user-socket/`).
- [x] Confirm `~/.config/opencode/mcp-apps.json` user-tier docxmcp entry points at the live socket (no edits required — current entry is already correct).
- [x] Verify `McpAppStore.loadConfig()` returns the user-tier `url` even when a system-tier entry with the same id exists (integration check or targeted unit assertion).
- [x] Verify the literal docxmcp URL passes through the resolver untouched (`expandedTokens.length === 0`).

## Phase 6 — Validation

- [x] Run targeted unit tests for `McpAppStore` merge, `resolveRuntimeUrl`, and `classifyStoreError`.
- [x] Rebuild + `system-manager:restart_self` (with user consent); smoke `docxmcp` MCP `initialize` over the live socket.
- [x] Smoke dispatcher upload path through docxmcp endpoint.
- [x] Verify `system-manager_list_mcp_apps` reports the live URL.

## Phase 7 — Sync

- [x] Update `specs/architecture.md` MCP App registry section with the layered merge contract.
- [x] Record scope-reframing event log entry under `events/`.
- [x] Record validation event log entry under `events/` after Phase 6.
- [x] `plan_advance` to `verified` once Phase 6 evidence is captured.
