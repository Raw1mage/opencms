# Observability: mcp_per_user_socket_rca

## Checkpoints

- **CP-1 `mcp_app.registry.loaded`:** `McpAppStore.loadConfig()` returned a docxmcp entry whose `urlTemplate` is the templated form (not the stale literal).
- **CP-2 `mcp_app.url.resolved`:** `resolveRuntimeUrl()` produced a concrete socket path; `expandedTokens` lists the tokens consumed; `unknownTokens` is empty.
- **CP-3 `mcp_app.dial.success`:** `connectMcpApps()` opened the resolved socket and MCP `initialize` returned `serverInfo.name=docxmcp`.
- **CP-4 `mcp_app.dispatcher.routed`:** HTTP upload reached docxmcp via the resolver-derived endpoint; upstream response was 200.
- **CP-5 `mcp_app.merge.layered`:** With stale system-tier URL + templated user-tier URL, the merged entry carries user-tier `url` and system-tier identity fields.
- **CP-6 `mcp_app.install.targeted`:** `install_mcp_app({ target: "user" })` wrote to `~/.config/opencode/mcp-apps.json` only; system tier file mtime unchanged.

## Evidence To Record

- Pre-patch baseline: `system-manager_list_mcp_apps` output showing stale URL; live socket path from `lsof | grep docxmcp` or `ss -lx`.
- Post-patch: same `list_mcp_apps` output showing resolved URL; both `urlTemplate` and `urlResolved` columns populated.
- `loadConfig()` returned entry shape (anonymised) for collision case + system-only + user-only.
- Resolver test outputs: each token in isolation, combined, `${XDG_RUNTIME_DIR}` fallback, unknown-token preservation.
- MCP `initialize` round-trip log including `serverInfo.name` + tool count.
- Dispatcher HTTP upload smoke: request id, upstream socket path, response code + size.
- `install_mcp_app` round-trip for both `target=system` and `target=user`, including pre/post file mtimes.

## Events

- `mcp_app.registry.loaded` — checkpoint event for layered merge output.
- `mcp_app.url.resolved` — checkpoint event for resolver output (also fires from dispatcher path).
- `mcp_app.dial.success` — checkpoint event for `connectMcpApps()` initialize handshake.
- `mcp_app.dispatcher.routed` — checkpoint event for HTTP upload route resolution.
- `mcp_app.merge.layered` — checkpoint event for collision-case merge correctness.
- `mcp_app.install.targeted` — checkpoint event for install-tier routing.
- `mcp_app.user_override_rejected` (E2) — fires when an immutable field is dropped from a user-tier entry.
- `mcp_app.install_failed` (E4) — fires with structured `cause` when persistence fails.

## Metrics

- `mcp_app_registry_entries_total`: number of entries per tier (`system` / `user`) after merge.
- `mcp_app_url_template_count`: entries whose stored `url` contains at least one `${...}` token; expected ≥ 1 once docxmcp is migrated.
- `mcp_app_url_resolver_calls_total`: counter, labelled by `appId` + `consumer` (`connectMcpApps` | `dispatcher`).
- `mcp_app_url_resolver_unknown_token_total`: counter of unknown tokens encountered; expected `0` in steady state.
- `mcp_app_dial_success_total`: counter of successful MCP `initialize` handshakes per `appId`.
- `mcp_app_dial_error_total`: counter of dial failures per `appId` + `errorClass` (`ENOENT` | `ECONNREFUSED` | `timeout`).
- `mcp_app_user_override_rejected_total`: counter of E2 events per `appId` + `field`; expected `0` in steady state.
- `mcp_app_install_total`: counter of install attempts per `target` + `result` (`ok` | E4 cause).
- `mcp_app_stale_system_url_dialed_total` (E6): expected `0` in steady state; non-zero means user-tier file is missing/unreadable.

## Signals

- New unit tests under `packages/opencode/test/mcp/` (or existing equivalent) covering merge collisions, resolver token expansion, install target routing.
- Integration test under the per-user daemon harness covering CP-1..CP-4 end-to-end with a fixture HTTP-over-unix server.
- Event log at `plans/mcp_per_user_socket_rca/events/event_2026-05-28_per_user_socket_resolution.md` (created during implementing).
- `specs/architecture.md` MCP App registry section reflects the new layered semantics + resolver contract.
- aisecurity sidecar telemetry: `mcp_app_url_resolver_calls_total` should appear once first dial routes through the resolver after restart_self.
