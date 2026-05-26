---
name: opencode-web-routes
description: "Register, update, remove, or debug web app entry points served by the opencode C gateway daemon. Use whenever the user mentions gateway web routes, web_registry.json, web_routes.conf, publish-route, ctl.sock, publicBasePath, exposing a local webapp under /prefix, or examples like /cecelearn, /linebot, /cisopro, /games/whack-a-mole."
---

# Opencode Gateway Web Routes

Use this skill before touching any gateway web route. Do not guess from curl output alone.

## Mental Model

The gateway route system has two independent layers:

| Layer               | File / API                                       | Owner        | Purpose                                                                                                                        | Edit directly? |
| ------------------- | ------------------------------------------------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------ | -------------- |
| User declaration    | `~/.config/web_registry.json`                    | current user | Declares managed webapps for health/toggle/UI: `entryName`, `projectRoot`, `publicBasePath`, upstream, `webctlPath`, `access`. | Yes            |
| Runtime route table | `/etc/opencode/web_routes.conf` + gateway memory | C gateway    | Actual routing table: `<prefix> <host> <port> <owner_uid> [auth]`.                                                             | No             |

Editing `~/.config/web_registry.json` does not publish a gateway route. Publishing a gateway route does not create a registry entry. New apps need both.

## Required Source Reading

Before changing anything, inspect these existing sources:

- `specs/architecture.md` — high-level web registry / gateway architecture.
- `specs/daemon/README.md` — two-layer registry design and route table details.
- `packages/opencode/src/server/routes/web-route.ts` — daemon API and ctl.sock bridge.
- `daemon/opencode-gateway.c` — gateway route loading / longest-prefix behavior, if debugging matching.

## Registry Schema

Example entry:

```json
{
  "entryName": "example",
  "projectRoot": "/home/pkcs12/projects/example",
  "publicBasePath": "/example",
  "prefix": "/example",
  "host": "127.0.0.1",
  "primaryPort": 5173,
  "webctlPath": "/home/pkcs12/projects/example/webctl.sh",
  "enabled": true,
  "access": "public",
  "autostart": true
}
```

Field rules:

- `entryName`: stable unique key for UI/toggle/health operations.
- `publicBasePath`: external URL prefix exposed by the gateway; must start with `/`.
- `prefix`: compatibility field used by some daemon catch-all bypass code; keep it equal to `publicBasePath` unless code proves otherwise.
- `host` / `primaryPort`: TCP upstream target for normal apps.
- `upstreamType: "uds"` / `upstreamSocket`: use instead of `host`/`primaryPort` for Unix socket apps.
- `webctlPath`: app control script; should support at least `start`, `stop`, and `status` when possible.
- `access`: registry label only; it does not set gateway auth by itself.
- `autostart`: daemon boot may start the service through `webctlPath start`.

## Publish Contract

Gateway publish is the step that writes/updates the runtime route table.

Preferred full-control command:

```bash
printf '%s\n' '{"action":"publish","prefix":"/example","upstreamType":"tcp","host":"127.0.0.1","port":5173,"auth":0}' \
  | socat - UNIX-CONNECT:/run/opencode-gateway/ctl.sock
```

Other ctl.sock actions:

```bash
printf '%s\n' '{"action":"list"}' | socat - UNIX-CONNECT:/run/opencode-gateway/ctl.sock
printf '%s\n' '{"action":"remove","prefix":"/example"}' | socat - UNIX-CONNECT:/run/opencode-gateway/ctl.sock
```

Auth mapping:

- `access: "public"` in registry usually means publish with `"auth": 0`.
- `access: "protected"` in registry usually means publish with `"auth": 1`.
- Do not assume registry `access` automatically updates gateway auth.

## Base Path Contract

The opencode gateway preserves the matched prefix when forwarding to upstream. It does not strip `/example` before proxying.

Therefore the app must support its `publicBasePath` explicitly:

- Static/file server apps must map `/example/` to their local `index.html`, or strip `/example` before file lookup.
- SPA bundles should use relative asset URLs or configure their build base to the same prefix, e.g. `/example/`.
- API servers must register routes under the prefix, or include middleware that strips the prefix before internal routing.
- Redirects and canonical URLs must include the external prefix, otherwise browsers may jump to `/` and hit opencode itself.
- Always test both `/example` and `/example/`; no-slash may redirect, slash should return app content.

If a route publishes successfully but returns `404`, check this first: the upstream may be receiving `/example/...` and looking for a local file or route at that literal path.

## Safe Workflow

1. Read existing registry and route table.
2. Pick a unique `publicBasePath` and port.
3. Add/update `~/.config/web_registry.json` entry.
4. Ensure the upstream app supports the base path.
5. Start the upstream via its own `webctl.sh start` if needed.
6. Publish the gateway route through ctl.sock.
7. Verify route list, upstream health, local gateway URL, and public HTTPS URL.

Verification commands:

```bash
printf '%s\n' '{"action":"list"}' | socat - UNIX-CONNECT:/run/opencode-gateway/ctl.sock
curl -s -o /tmp/app.out -w "%{http_code} %{content_type}" http://127.0.0.1:1080/example/
curl -k -s -o /tmp/app-public.out -w "%{http_code} %{content_type}" https://cms.thesmart.cc/example/
```

## Do Not

- Do not edit `/etc/opencode/web_routes.conf` directly; gateway owns and may rewrite it.
- Do not restart, kill, or spawn the opencode daemon/gateway from Bash.
- Do not assume editing user registry activates a route.
- Do not assume publishing a route adds it to the managed-app registry.
- Do not assume gateway strips the route prefix.
- Do not use fallback routes or default ports silently; fail fast and preserve evidence.

## Common RCA Patterns

| Symptom                                          | Likely Cause                                                                                 | Check                                                    |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Works on upstream port, 404 through gateway      | App does not handle preserved base path.                                                     | Curl upstream with the prefixed path.                    |
| Gateway returns opencode frontend instead of app | Registry/catch-all bypass does not see `prefix`/`publicBasePath`, or route is not published. | Check `~/.config/web_registry.json` and ctl.sock `list`. |
| Route works but not shown in UI                  | Published route exists but no user registry entry.                                           | Check `entries[]` in `~/.config/web_registry.json`.      |
| UI health says dead but gateway works            | Registry upstream port/socket differs from published route.                                  | Compare registry vs ctl.sock `list`.                     |
| Public route asks for login unexpectedly         | Published with `auth: 1`.                                                                    | Remove and re-publish with `auth: 0`.                    |
| `/foo` redirects or fails but `/foo/` works      | App or server has slash normalization mismatch.                                              | Test both paths and inspect `Location` header.           |
