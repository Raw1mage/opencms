---
date: 2026-05-11
summary: "Add gateway-as-platform section + web-route.ts code anchors"
---

# Add gateway-as-platform section + web-route.ts code anchors

2026-05-11 release-prep doc refresh.

Added new section **Gateway-as-platform: registered webapps** between
the `/etc/opencode/` configuration section and the `restart_self` path,
describing the two-layer state model:

- `~/.config/web_registry.json` — user declaration (entryName /
  publicBasePath / host / primaryPort / webctlPath / enabled /
  access).
- `/etc/opencode/web_routes.conf` — gateway-managed route table
  (longest-prefix match at `load_web_routes()`).

Flow documented: user edits registry → `web-route` HTTP API on
per-user daemon validates and forwards to `webctl.sh publish-route`
→ ctl.sock → gateway rewrites `web_routes.conf` and reloads
in-memory. No restart required. TCP-probe health surfaced in Admin
Panel. Auth split (public vs protected) covered.

Roadmap line added: remote gateway-to-gateway federation (in design)
with open questions on trust model, prefix collision, peering
discovery, auth replay.

Code anchors updated with:
- `packages/opencode/src/server/routes/web-route.ts` —
  `registryPath()` L43, `readRegistry()` L48, `tcpProbe()` L55,
  webctl runner L76, ctl.sock client L97, handlers ~L180+, health
  endpoint ~L253.

Driver: user-elevated feature `gateway-as-platform / registered
webapps` from top-level README/architecture.md pass; this chapter
previously had partial coverage (web_routes.conf + publish-route
mentioned, but web_registry.json + web-route.ts daemon-side handler
missing).
