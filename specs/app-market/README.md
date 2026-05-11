# app-market

> Wiki entry. Source of truth = current code under
> `packages/app/src/components/dialog-app-market.tsx`,
> `packages/opencode/src/server/routes/mcp.ts`,
> `packages/opencode/src/mcp/app-registry.ts`,
> `packages/opencode/src/mcp/app-store.ts`, and
> `~/.config/opencode/managed-apps.json`. Replaces the legacy spec
> package `app-market/20260325_mcp-market-plan-review/`.

## Status

shipped (live as of 2026-05-04). The 2026-03-25 slice promoted the App
Market into the unified surface for *all three* MCP component kinds —
standard servers, managed apps, store apps — and made the dialog
mobile-responsive. It is now the canonical inventory UI inside the
webapp's Admin Panel, served by `/api/v2/mcp/market`.

## Current behavior

### What App Market means here

Not a separate product — it is the unified install / configure /
enable surface for everything the per-user daemon can expose as an
MCP-style tool. Three component kinds coexist in one list:

| Kind | Source | Lifecycle |
|---|---|---|
| `mcp-server` | `mcp.json` standard servers (stdio / HTTP) | Connect / Disconnect |
| `managed-app` | Built-in opencode apps in `managed-apps.json` | Install → Configure → Enable |
| `mcp-app` | Store apps in `mcp-apps.json` (user + system tier) | Install → Enable / Disable |

There is no remote market catalog. The list is the union of (a) what
the operator already has in `mcp.json`, (b) the managed-app registry
IDs (`google-calendar`, `gmail`, etc.; `BUILTIN_CATALOG` is currently
empty per `mcp/app-registry.ts:272`, so this kind is a managed-apps
mechanism on standby), and (c) what `McpAppStore` finds on disk.

### Catalog endpoint

`GET /api/v2/mcp/market` (`server/routes/mcp.ts` L29–L116) fans out:

```ts
const [serverApps, managedApps, storeApps] = await Promise.all([
  MCP.serverApps(),
  ManagedAppRegistry.list(),
  McpAppStore.listApps().catch(() => []),
])
```

Each is normalized to a `MarketApp` shape (`kind`, `name`,
`description`, `icon`, `status`, `tools`, `enabled`, optional `auth`
and `error`). The route also reads `~/.config/opencode/gauth.json` so
store apps requiring Google OAuth surface `status: "needs_auth"` with
`error: "OAuth token expired"` instead of failing silently.

### Per-app endpoints

For `managed-app` (operated by `ManagedAppRegistry`):
`POST /apps/:appId/install`, `/uninstall`, `/config`, `/enable` (with
`403/409/503` via `managedAppUsageHttpStatus(reason)`), `/disable`,
`GET /apps/:appId/oauth/connect`, `/oauth/callback`.

For `mcp-server`: `POST /:id/connect`, `/disconnect`.

For `mcp-app` (store apps): `GET /store/apps`, `POST /store/apps`
(register from GitHub URL or local path via
`McpAppStore.cloneAndRegister` / `addApp`),
`POST /store/apps/preview` (dry-run manifest read),
`PATCH /store/apps/:id` (enabled toggle), `/store/apps/:id/config`
(secrets), `DELETE /store/apps/:id` (uninstall).

### Where the catalog lives

- **Managed apps** — `~/.config/opencode/managed-apps.json` (path
  `Global.Path.user`). Schema in `mcp/app-registry.ts`: `Capability`,
  `Permission`, `AuthContract`, `ConfigContract`, `ToolDescriptor`,
  plus operator state (install / config completion) and runtime state
  (`runtimeStatus`). `Bus` event `managed_app.updated` notifies the UI.
- **Store apps** — two-tier registry in `McpAppStore`:
  - `/etc/opencode/mcp-apps.json` (system, managed by
    `sudo /usr/local/bin/opencode-app-install`).
  - `~/.config/opencode/mcp-apps.json` (user, managed by per-user
    daemon).
  - System wins on `id` collision.
- **Standard MCP servers** — declared in `mcp.json`, surfaced via
  `MCP.serverApps()`. Runtime side documented in [mcp.md](../mcp/README.md).

`managed-apps.json` is on the AGENTS.md backup whitelist — operator
state worth preserving across resets.

### Dialog UI

`dialog-app-market.tsx` renders the unified card grid:

- Card minimum width `CARD_MIN_W = 260px`.
- `createMediaQuery("(max-width: 767px)")` flips to single-column,
  action-stacked layout on narrow viewports — the original responsive
  fix from the 2026-03-25 plan review.
- Status pills via `statusDisplay(app)` map per-kind enums to
  labelKey + color (`connected` / `ready` / `disabled` / `needs_auth`
  / `pending_install` / `error`).
- Tools per app are collapsible (`expandedTools` set).
- Add-app dialog accepts GitHub URL or local path with preview before
  commit.
- Per-app settings dialog renders dynamic fields from
  `settingsSchema` returned by the catalog endpoint.

The dialog opens from Admin Panel chrome
(`pages/layout.tsx:1065 → dialog.show(() => <DialogAppMarket />)`).

### OAuth surface

OAuth-bearing apps (Google Calendar, Gmail) flow through a pop-up
window at `/api/v2/mcp/apps/:appId/oauth/connect` (600×700). The
callback persists the token and emits `managed_app.updated` so the
dialog refetches and shows green. Token expiry surfaces as
`needs_auth` + `error: "OAuth token expired"`.

## Code anchors

Frontend:
- `packages/app/src/components/dialog-app-market.tsx` — unified
  dialog (~754 LOC after 2026-05 slimdown, was ~1100 LOC). `MarketApp` type L23, `statusDisplay` L42,
  `fetchMarket` L102, OAuth pop-up L149, settings save L164, store
  add L202.
- `packages/app/src/components/dialog-app-market.css` — responsive
  grid + card styling.
- `packages/app/src/pages/layout.tsx` — open site (L1065).

Backend:
- `packages/opencode/src/server/routes/mcp.ts` — all endpoints. Market
  fan-out L29, managed-app CRUD L119–L267, store-app CRUD L827–L940.
- `packages/opencode/src/mcp/app-registry.ts` — `ManagedAppRegistry`,
  persists to `~/.config/opencode/managed-apps.json` (L14), emits
  `managed_app.updated` (L262).
- `packages/opencode/src/mcp/app-store.ts` — `McpAppStore` two-tier
  registry, `cloneAndRegister`, `addApp`, `setEnabled`, `setConfig`.
- `packages/opencode/src/mcp/index.ts` — `MCP.serverApps()` (L811),
  shared `ServerApp` shape (L803).

Persistence:
- `~/.config/opencode/managed-apps.json` — managed-app registry.
- `~/.config/opencode/mcp-apps.json` — user-tier store apps.
- `/etc/opencode/mcp-apps.json` — system-tier store apps.
- `~/.config/opencode/gauth.json` — Google OAuth tokens.

## Notes

- `BUILTIN_CATALOG` in `mcp/app-registry.ts:272` is intentionally
  empty in current code: managed-app entries used to live there but
  Gmail / Calendar were promoted to standalone stdio MCP servers
  under `mcp-apps.json`. Schema and CRUD remain for future managed
  apps; today the market is effectively `serverApps + storeApps`.
- The `mcp-finder` skill is the recommended way to discover and
  install third-party MCP servers — it ultimately calls the same
  `POST /api/v2/mcp/store/apps` endpoint the dialog uses.
- Mobile responsive overhaul (the 2026-03-25 plan-review motivation)
  is verified: cards reflow without horizontal overflow on narrow
  viewports, search and primary actions remain visible.

### Related entries

- [mcp.md](../mcp/README.md) — MCP runtime: how connected / installed apps
  actually run as tool surfaces, transports, idle-unload (proposed),
  tool-direct-render (proposed).
- [webapp.md](../webapp/README.md) — the Admin Panel chrome that hosts this
  dialog.
- [daemon.md](../daemon/README.md) — per-user daemon that owns
  `managed-apps.json` and `mcp-apps.json` and serves `/api/v2/mcp/*`.
- [meta.md](../meta/README.md) — `/etc/opencode/mcp-apps.json` system-tier
  config surface and the sudo wrapper.
- [session.md](../session/README.md) — how installed app tools are exposed
  to the AI inside a session.
