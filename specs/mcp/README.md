# mcp

> Wiki entry. Source of truth = current code under
> `packages/opencode/src/mcp/`, `packages/opencode/src/session/`, and
> `packages/mcp/`. Replaces the legacy spec packages `mcp_subsystem/`
> (`mcp-separation/` + `tool-direct-render/`), the `mcp-idle-unload/`
> proposal, and the `docxmcp-http-transport/` package.

## Status

partially shipped (live as of 2026-05-04).

`mcp_subsystem/mcp-separation` is largely shipped — `BUILTIN_CATALOG`
is empty, Gmail / Calendar run as standalone stdio MCP servers under
`mcp-apps.json`, and the four-layer model (system user / package
convention / two-tier registry / conversational provisioning) is in
production. `docxmcp-http-transport` reached `living` — Streamable
HTTP over Unix domain socket is wired end-to-end (per-app transport
switch in `mcp/index.ts`, multipart `/files` uploader in
`incoming/dispatcher.ts`, bind-mount lint with IPC exception in
`mcp/app-store.ts`). `mcp-idle-unload` is `proposed`: the
`mcpAppsInitialized` boolean flag is still in place at
`mcp/index.ts:1060`; no idle sweeper, no `lastUsedAt` tracking, no
`tweaks.cfg` knob has shipped. `tool-direct-render` is also
`proposed`: the `modelProcess` array is plumbed through
`McpAppManifest.Schema` and `AppEntry` but no runtime enforcement
intercepts tool output to swap in the compact summary.

## Current behavior

### Two namespaces, one tool surface

`MCP` (`mcp/index.ts`) is the lifecycle / connection / tool-conversion
surface for everything that speaks the MCP protocol. It owns
per-process state (`clients`, `status`, `toolsCache`),
`StreamableHTTPClientTransport` / `SSEClientTransport` /
`StdioClientTransport` selection, OAuth wiring (`McpOAuthProvider` +
`McpOAuthCallback`), and the `tools()` aggregation that
`session/resolve-tools.ts` consumes.

`ManagedAppRegistry` (`mcp/app-registry.ts`) is the lifecycle state
machine for runtime-owned MCP apps: `available → installed →
pending_config → pending_auth → ready` plus `disabled` / `error`. It
persists to `~/.config/opencode/managed-apps.json`. After
`mcp-separation` Step 6, `BUILTIN_CATALOG` is the empty map — Gmail
and Calendar were migrated to standalone stdio servers and the
managed-app executor / convertManagedAppTool path was deleted. The
namespace's schemas (`CatalogEntry`, `AppSnapshot`, `AuthBinding`,
`OperatorState`, `ReadyToolBinding`) are kept for the API surface and
for any future re-entry of in-process apps.

The two namespaces are decoupled: `MCP` does not consult
`ManagedAppRegistry`, and `mcp-apps.json` (the App Store) is the only
runtime input that drives connection.

### Three-layer mcp-apps registry

```
McpAppManifest (per-app)              mcp.json on disk; Zod-validated.
McpAppStore     (two-tier registry)   /etc/opencode/mcp-apps.json (system)
                                      ~/.config/opencode/mcp-apps.json (user)
                                      system wins on id collision.
ManagedAppRegistry (lifecycle FSM)    ~/.config/opencode/managed-apps.json
                                      currently empty BUILTIN_CATALOG.
```

`McpAppManifest.load(dir)` reads `mcp.json` → Zod-validates against
the `Schema` (id, name, command/url, transport, auth, settings,
modelProcess, source). On `ENOENT`, it attempts `infer()` from
`package.json` / `pyproject.toml` / `requirements.txt`+`server.py` and
writes a generated `mcp.json`; if inference fails it throws
`McpManifestNotFoundError` — never silent.

`McpAppStore` operates in two tiers. `loadConfig()` reads both files
and merges with system-tier priority. User-tier writes go through
`saveUserConfig()` directly; system-tier writes call `sudoWrapper()`
(`/usr/local/bin/opencode-app-install write-entry|clone|remove ...`)
which atomically replaces the entry under `opencode:opencode`
ownership. `addApp(id, path, target)` runs `buildEntry`, which
`probeTools()` via a throwaway stdio connection to capture `tools/list`
output, and lints the resolved command for forbidden bind mounts (see
below).

### Lazy connection on first tool call

`MCP.tools()` is the entry point for all tool aggregation in the
runloop. The first call into `tools()` triggers `connectMcpApps()`,
which is gated by the process-level boolean `mcpAppsInitialized` flag
(`mcp/index.ts:1060`). For each enabled `mcp-apps.json` entry:

- if `entry.transport === "streamable-http" | "sse"` → call
  `MCP.add()` with `type=remote, url=entry.url` (used by docxmcp);
- otherwise → load `mcp.json`, resolve auth env via `resolveAuthEnv`
  (Google OAuth reads from `gauth.json` with auto-refresh; other
  providers stubbed for `accounts.json`), inject
  `OPENCODE_OUTPUT_DIR=<projectRoot>/.opencode/mcp-output`, inject
  `entry.config` as upper-cased env vars, and call `MCP.add()` with
  `type=local, command=entry.command`.

`mcpAppsInitialized` flips to `true` once and never flips back.
That means **store-app clients are pinned for the daemon's
lifetime** — see `mcp-idle-unload` proposal under Notes.

### Per-app transport switch

`mcp-apps.json` entries carry `transport: "stdio" | "streamable-http"
| "sse"` (default `stdio`). `connectMcpApps` routes `streamable-http`
/ `sse` through `MCP.add({type: "remote", url})`, and `stdio` through
`MCP.add({type: "local", command})`. Inside `MCP.create()`, remote
entries with a `unix://` URL are detected by `parseUnixSocketUrl()`
and connected via a custom `fetch` that passes `{unix: socketPath}`
to Bun's `fetch` — no TCP port involved. URL form:

```
unix:///run/user/<uid>/opencode/sockets/<app>/<app>.sock:/<http-path>
```

The `:/` separator splits the absolute socket path from the HTTP
path. SSE fallback is attempted second if Streamable HTTP fails.

### Bind-mount lint with narrow IPC exception

`McpAppStore.findBindMountViolations(command)` is a static predicate
applied to every docker-style command at registration time
(`addApp`/`buildEntry`). It parses `-v`, `--volume`, and `--mount
type=bind` arguments, then allows mounts only when both:

- host path matches `^/run/user/\d+/opencode/sockets/[a-z0-9-]+/?$`,
- container path matches `^/run/[a-z0-9-]+/?$`.

Anything else is rejected with `bind_mount_forbidden: ...
(policy: specs/_archive/docxmcp-http-transport)`. This is the only allowed
bind mount across the entire MCP ecosystem; named volumes are still
permitted (used by docxmcp's `docxmcp-cache:/var/cache/docxmcp/...`).

### docxmcp HTTP transport (replaced bind-mount staging)

docxmcp's host↔container bridge moved from `docker run -i -v
.../mcp-staging:/state docxmcp` per-call to `docker compose up -d`
permanent + Streamable HTTP MCP over Unix domain socket. The
container exposes `/mcp` (MCP protocol) plus a content-addressed file
API: `POST /files` (multipart raw bytes) → `{token, sha256, size}`,
`GET /files/{token}`, `DELETE /files/{token}`. Tokens have format
`tok_<32-char-base32>` (160-bit entropy).

All 21 docxmcp tools accept `token: string` instead of path. The
opencode-side `IncomingDispatcher.before()` (called from
`convertMcpTool`'s `execute` wrapper) scans args for project-relative
paths, multipart-uploads them, and rewrites `path → token` before the
mcp `tools/call`. After the call, `IncomingDispatcher.after()` decodes
any `structuredContent.bundle_tar_b64` into the bundle's repo
location and best-effort `DELETE`s the token.

To make this work with the AI SDK's pre-execute schema validation,
`relaxTokenFieldsForDispatcher()` strips the strict
`^tok_[A-Z2-7]{32}$` pattern from token fields in the schema we
expose to the model, so it can pass either a token or a
project-relative path. The dispatcher does the substitution before
the args reach the docxmcp server.

Per-user isolation: each system user runs `docker compose -p
docxmcp-${USER} up -d` and gets its own socket at
`/run/user/${UID}/opencode/sockets/docxmcp/docxmcp.sock` (dir 0700,
sock 0600). Bundle cache (`docxmcp-cache` named volume) is shared
across users by sha; tokens are container-scoped and cleared on
restart.

### managed-apps.json / gauth.json

`~/.config/opencode/managed-apps.json` is the persistence file for
`ManagedAppRegistry` (`AppState` per app: `installState`,
`enableState`, `configStatus`, `config.keys`, `error`). With
`BUILTIN_CATALOG` empty in the current build, the file is unused at
runtime but the schema and CRUD surface are intact.

`~/.config/opencode/gauth.json` holds the shared Google OAuth token
that Gmail and Calendar (now standalone stdio servers under
`mcp-apps.json`) read from. `MCP.resolveAuthEnv()` looks up this file
when an mcp app's manifest declares `auth: { type: "oauth", provider:
"google", tokenEnv: ... }`, auto-refreshes via Google's
`oauth2.googleapis.com/token` if `expires_at` is within 5 minutes,
and injects both `tokenEnv` and `refreshTokenEnv` into the spawned
server's environment. A 45-minute background sweeper
(`startGauthRefreshTimer`) keeps the token fresh once any Google app
is connected.

### Tool surface aggregation

`session/resolve-tools.ts` aggregates the registry tools, MCP tools
(via `MCP.tools()`), session/agent/permission filters, and the
`enablement.json` catalog before handing the result to
`session/llm.ts`. The catalog (`enablement.json`) lists every tool /
skill / MCP capability the model is expected to know about. It exists
in two places that must stay byte-equal in steady state:

- runtime: `packages/opencode/src/session/prompt/enablement.json`
- template: `templates/prompts/enablement.json`

`mcp-finder` and `skill-finder` MCPs (and the harness
mandatory-skills layer) can mutate the runtime copy when new
capabilities are installed. The template copy must be updated in the
same commit so fresh installs ship the same surface. AGENTS.md (root
of repo) treats this as an invariant.

`tool_loader` is a registry tool that lists "lazy-loaded" MCP tools —
tools whose schemas are not eagerly attached to every prompt to keep
the system block compact. The model calls `tool_loader.activate(name)`
when it needs one, and `experimental_repairToolCall` re-tries with
the activated tool. Implementation in `session/resolve-tools.ts`
around lines 18 / 329.

### Plugin boundary

`packages/opencode/src/plugin/` (anthropic, codex, copilot, gemini,
claude-native) is the LLM-provider plugin layer — separate from
`mcp/`. Plugins implement `experimental.chat.system.transform` and
`experimental.chat.context.transform` hooks for prompt-shape
adjustments; they do not extend the tool surface. Tool extension is
exclusively MCP-driven.

### Direct render — proposed only

`tool-direct-render` proposes a `modelProcess: string[]` field on
`McpAppManifest` that lists tool names whose output _must_ go through
the model (write-style tools); read-only tools default to direct
render — the UI gets full output, the model gets a `[Direct render:
displayed to user — N chars]` summary. The field is plumbed today:
`McpAppManifest.Schema.modelProcess` is parsed, `McpAppStore.AppEntry`
persists it, `buildEntry` copies it from manifest to entry. But
`session/resolve-tools.ts` does not yet branch on it — every tool's
full output still flows back into model context.

The Direct Render TODO from MEMORY.md goes further: make the
`open_fileview` mechanism (used by `system-manager` MCP at
`packages/mcp/system-manager/src/index.ts`) a standard tool protocol
so any MCP can emit a "render this file directly" reply that the UI
opens in a fileview tab without consuming model tokens. The current
escape hatch is the `OPENCODE_OUTPUT_DIR` env var that
`connectMcpApps` injects, pointing at `<projectRoot>/.opencode/mcp-output`
— tools save files there, then invoke `open_fileview`. Fileview
needs absolute-path support to retire this `.opencode/mcp-output/`
workaround.

## Code anchors

Core:
- `packages/opencode/src/mcp/index.ts` — `MCP` namespace (1577 lines).
  `tools()` at L1187, `create()` at L490, `connectMcpApps()` at L1067,
  `convertMcpTool()` at L180, `parseUnixSocketUrl()` at L20,
  `relaxTokenFieldsForDispatcher()` at L165, `resolveAuthEnv()` at
  L973, `startGauthRefreshTimer()` at L1034, `mcpAppsInitialized` flag
  at L1060.
- `packages/opencode/src/mcp/app-store.ts` — `McpAppStore` namespace
  (499 lines). `loadConfig()` at L103, `addApp()` at L341,
  `buildEntry()` at L262, `probeTools()` at L161,
  `findBindMountViolations()` at L212, `sudoWrapper()` at L129.
- `packages/opencode/src/mcp/manifest.ts` — `McpAppManifest`. Schema
  at L75, `load()` at L132, `infer()` at L174, `Auth` discriminated
  union at L35, `Settings` at L55.
- `packages/opencode/src/mcp/app-registry.ts` — `ManagedAppRegistry`
  (798 lines). `BUILTIN_CATALOG` empty at L272. State machine
  (`install` / `uninstall` / `enable` / `disable` / `setConfigKeys`)
  L604–L726. `runtime-attachments` Map for session-owned attachment
  L258. Persistence to `Global.Path.user/managed-apps.json` at L14.
- `packages/opencode/src/mcp/oauth-provider.ts`,
  `mcp/oauth-callback.ts`, `mcp/auth.ts` — OAuth wiring for remote
  MCP servers.

Tool surface:
- `packages/opencode/src/session/resolve-tools.ts` — aggregation
  boundary; lazy `tool_loader` catalog at L329, enablement injection
  at L18.
- `packages/opencode/src/session/llm.ts` — enablement snapshot
  injection into the prompt.
- `packages/opencode/src/session/prompt/enablement.json` — runtime
  capability catalog.
- `templates/prompts/enablement.json` — template copy; must stay in
  sync.

Routes / server:
- `packages/opencode/src/server/routes/mcp.ts` — `/api/v2/mcp/*`:
  store CRUD, OAuth connect/callback, `audit-bind-mounts`, market
  preview/add.

External MCP packages:
- `packages/mcp/system-manager/src/index.ts` — built-in
  `system-manager` MCP (account switch, session monitor, fileview,
  managed-app reads). Hosts `open_fileview` and the
  `read_subsession` / `list_subagents` tools called out in
  [harness/README.md](../harness/README.md).
- `packages/mcp/branch-cicd` — `beta-tool` MCP (newbeta / syncback /
  merge).

docxmcp transport:
- `packages/opencode/src/incoming/dispatcher.ts` (561 lines) —
  HTTP-uploader path; `before()` multiparts paths to `/files`,
  `after()` decodes `bundle_tar_b64` and `DELETE`s tokens.
- See `attachments.md` for the full repo-incoming-attachments
  pipeline.

Tests (representative):
- `mcp.test.ts`, `mcp-app-store.test.ts`,
  `app-store.bind-mount-lint.test.ts`,
  `manifest.infer.test.ts`,
  `resolve-tools.test.ts`,
  `incoming/dispatcher.test.ts` (HTTP uploader regression set).

## Notes

### Open work — `mcp-idle-unload` (proposed)

The `mcpAppsInitialized` boolean must become a `Set<string>` of
connected ids; per-client `lastUsedAt` recorded in `convertMcpTool()`;
a 30-second idle sweeper unloading `mcpapp-*` clients with
`lastUsedAt + idle_unload_ms < now && inflight === 0`; threshold
configurable via `tweaks.cfg` (`mcp.idle_unload_ms`, default 5
minutes); `mcp.app.unloaded` Bus event emitted. `connectMcpApps()`
becomes idempotent per id. The pin matters for docker-based store
apps (now on the table for docxmcp and future entries) where each
container costs ~50 MB RSS. Non-store entries
(`opencode.json.mcp`-configured) and managed apps stay pinned. None
of this has shipped.

### Open work — `tool-direct-render` (proposed)

`modelProcess` is on disk in manifests and entries but the runloop
does not branch. Implementation needs to land in
`session/resolve-tools.ts` around L221–L303 (the MCP-tool-result
normalization site per `tool-direct-render/handoff.md`), gated by
`SG-1` (zero regression for non-listed tools), `SG-2` (model
receives ≤ 200 tokens for direct results), `SG-3` (fullOutput cap 64
KB). The broader Direct Render Protocol — every MCP tool can opt in
to a "render directly to fileview" reply shape — is still an
unwritten spec; tracked under MEMORY.md `project_direct_render_protocol`.

### Enablement Registry sync invariant

Mutations from `mcp-finder` / `skill-finder` (or any future installer)
that change runtime capability surface must update both
`packages/opencode/src/session/prompt/enablement.json` (runtime) and
`templates/prompts/enablement.json` (template). AGENTS.md treats
divergence as a bug — fresh installs would otherwise ship a different
surface than the running daemon advertises.

### Security policy: bind-mount ban

Cross-cutting since `docxmcp-http-transport`. New MCP apps registered
via `POST /api/v2/mcp/store/apps` are linted at `addApp` time. Any
`-v <host>:<container>` outside the IPC rendezvous exception is
rejected with `bind_mount_forbidden`. `GET
/api/v2/mcp/store/audit-bind-mounts` scans existing entries; the
follow-up purge spec (`mcp-bind-mount-audit-purge`) is not yet
written.

### Persistence

- `~/.config/opencode/mcp-apps.json` — user-tier App Store
  (`McpAppStore`).
- `/etc/opencode/mcp-apps.json` — system-tier App Store, written via
  sudo wrapper.
- `~/.config/opencode/managed-apps.json` — `ManagedAppRegistry`
  state (currently empty catalog → quiescent).
- `~/.config/opencode/gauth.json` — shared Google OAuth token.
- `~/.config/opencode/mcp.json` — legacy free-form MCP config (raw
  servers); section-isolated and lazy.

### Related entries

- [harness/](../harness/README.md) — `skill-finder` / `mcp-finder`
  for tool-surface expansion; the mandatory-skills layer that pins
  newly-discovered capabilities into the registry that feeds
  enablement (formerly `agent-runtime/`).
- [attachments.md](../attachments/README.md) — repo-incoming-attachments
  pipeline; docxmcp consumer side. The `docx-upload-autodecompose`
  flow (fast outline + background body) lives there.
- [session.md](../session/README.md) — runloop integration of MCP tools via
  `resolve-tools.ts`.
- [architecture.md](./architecture.md) — system-wide MCP overview;
  `## Managed App Registry (MCP Apps)` and `## Incoming Attachments
  Lifecycle` sections give the cross-system view.
