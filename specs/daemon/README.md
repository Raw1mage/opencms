# daemon

> Wiki entry. Source of truth = current code under `daemon/`,
> `packages/opencode/src/server/`, `packages/opencode/src/tool/bash.ts`,
> `packages/mcp/system-manager/src/index.ts`, `webctl.sh`, and
> `/etc/opencode/`. Replaces the legacy spec packages
> `daemonization` and `safe-daemon-restart` (the former `daemonization`
> folder remains as a privileged-gateway baseline reference; the latter
> is `living`).

## Status

shipped (live as of 2026-05-04).

`daemonization` reached production after seven C-gateway hardening
sessions; the SSOT for current daemonization behavior is split between
this entry, `specs/architecture.md`, and the gateway / daemon source.
`safe-daemon-restart` shipped 2026-04-21 (`a17d963bb` merged into main)
and is `living` — the AI-only `restart_self` path, `bash.ts`
`DAEMON_SPAWN_DENYLIST`, gateway orphan cleanup, and runtime-dir
guarantee are all in production.

## Current behavior

### Three-tier process model

```
Browser → nginx (HTTPS, HTTP/2) → TCP :1080 → C Gateway (root, single host process)
  → PAM auth (pthread) → JWT (HMAC-SHA256, file-backed secret)
  → fork+setsid+initgroups+setgid+setuid+execvp → per-user opencode daemon (Unix socket)
  → splice() zero-copy bidirectional proxy
```

Tier 1 is the C gateway (`daemon/opencode-gateway.c`, ~3.4k LOC,
installed at `/usr/local/bin/opencode-gateway`, runs as root via
`opencode-gateway.service`). It owns the public TCP port, terminates
PAM auth, issues JWTs, forks per-user daemons, and `splice(2)`s bytes
between client and daemon at L4. Tier 2 is the per-user `bun` daemon
(one per logged-in uid), listening on a Unix socket under
`$XDG_RUNTIME_DIR/opencode/daemon.sock`. Tier 3 is the optional TUI
client which adopts an existing daemon via the discovery file.

### Gateway event loop

Single-threaded `epoll` main loop. PAM is the only blocking primitive
and is moved off-loop into a dedicated pthread that signals readiness
via `eventfd`. Initial HTTP request reads use a per-connection
non-blocking `PendingRequest` buffer (8 KB, accumulate until
`\r\n\r\n`; oversize → 400, 30 s no-progress → 408). epoll fds carry a
tagged `EpollCtx` discriminated union with five types — `LISTEN`,
`PENDING`, `SPLICE_CLIENT`, `SPLICE_DAEMON`, `AUTH_NOTIFY` — so events
dispatch by source rather than by guessing fd ownership.

`close_conn()` does `EPOLL_CTL_DEL` before `close(2)`, decrements
`g_nconns`, and releases the connection slot (cap `MAX_CONNS=1024`).
A per-connection `closed` flag guards against same-round duplicate
events. JWT secret persists at `/run/opencode-gateway/jwt.key` (root
0600, generated on first start, rotated by delete + restart). Login
rate limit is per-IP sliding window (5 fails / 60 s → 429) hashed mod
256, no persistence.

### Gateway-owned routes (handled before JWT verification)

- `POST /auth/login` — PAM auth → JWT issue. Login success returns
  HTML that sets `document.cookie='oc_jwt=...'` client-side and
  `window.location.replace('/')`, bypassing nginx HTTP/2 response
  header stripping.
- `GET /api/v2/global/health` — unauthenticated health probe for load
  balancers.
- All other routes — JWT verify (case-insensitive `Cookie:` /
  `cookie:` parse for nginx HTTP/2→HTTP/1.1 lowercasing) →
  `find_or_create_daemon(uid)` → splice.

### Per-user daemon lifecycle

Discovery file at `$XDG_RUNTIME_DIR/opencode/daemon.json` (managed by
`Daemon` namespace in `packages/opencode/src/server/daemon.ts`),
companion `daemon.pid` and `daemon.sock` in the same dir. The gateway
does discovery-first adopt: read `daemon.json`, verify PID via
`/proc/<pid>` liveness + uid match, probe socket. If adopt fails it
spawns; the spawned daemon writes the discovery file once
`Server.listenUnix()` is ready.

Spawn is privileged: gateway (root) does `mkdir -p
/run/user/<uid>/opencode` + `chown <uid>:<gid>` + `chmod 0700`
**before** fork, so child can bind socket after `setuid`. Runtime-path
detection order: `/run/user/<uid>/` → `$XDG_RUNTIME_DIR` →
`/tmp/opencode-<uid>/` (mkdir 700). `OPENCODE_BIN` is parsed via
`parse_opencode_argv()` into argv[] before fork; child uses `execvp`,
not `sh -c`, so post-`setuid` shell metachars cannot escape. SIGCHLD
exit status is logged.

The daemon entry point is `cli/cmd/serve.ts` `--unix-socket=<path>`
(via `Server.listenUnix()` in `server/server.ts`). On clean shutdown
it calls `Daemon.removeDiscovery()` to unlink all three files.

### `daemon.lock` PID file (NOT kernel flock)

Single-instance enforcement uses a JSON PID file at
`~/.config/opencode/daemon.lock` (`{pid, acquiredAtMs}`) plus
`process.kill(pid, 0)` liveness — see
`packages/opencode/src/daemon/gateway-lock.ts`. It is **not** a kernel
`flock(2)` — design decision DD-3b from `safe-daemon-restart` after
implementation discovered `fcntl(F_OFD_GETLK)` always reported "no
holder" on this lock shape. Orphan detection reads the JSON, takes
the pid, validates `/proc/<pid>` `st_uid == target_uid` (defends
against pid recycling and cross-uid attacks), then escalates SIGTERM
→ 1 s waitpid → SIGKILL before `unlink(socket_path)` and forking the
new daemon.

### TUI adopt path

`packages/opencode/src/cli/cmd/tui/thread.ts` calls
`Daemon.spawnOrAdopt()` (always-attach contract). `--attach` is
strict: connects only to an existing gateway-spawned daemon via
discovery, never auto-spawns. Per-user daemon lifecycle authority
sits with the gateway; TUI is a client.

### `webctl.sh` orchestration

Single shell entry-point at repo root (also installed as
`/etc/opencode/webctl.sh`). Subcommands relevant here:

- `dev-start` / `dev-up` — boot the dev runtime (`bun
  --conditions=browser .../index.ts`). Calls `switch_gateway_mode dev`
  if needed.
- `dev-stop` / `stop` — terminate dev daemons.
- `dev-refresh` — alias for `restart` with the same flags forwarded.
- `restart [--graceful] [--force-gateway] [--force]` — the canonical
  rebuild+restart path. Smart-skips per-layer via content fingerprint:
  - Daemon source layer (`packages/opencode/src/**`) — rebuild bundle,
    or in dev mode just re-exec.
  - Frontend layer (`packages/app/src/**`, prod only) — rebuild and
    deploy to `/usr/local/share/opencode/frontend/`. Dev skips (vite
    HMR handles it).
  - Gateway C binary (`daemon/opencode-gateway.c`) — `make` + install
    + `systemctl restart opencode-gateway` only when the source is
    newer than `/usr/local/bin/opencode-gateway`, when
    `/etc/opencode/opencode.cfg` changed since the service started, or
    when `--force-gateway` is set.
- `_restart-worker` — internal command used by the detached worker.
- `daemon-killall` — kick all per-user daemons (they auto-respawn on
  next authenticated request).
- `publish-route` / `remove-route` / `list-routes` — manage
  `/etc/opencode/web_routes.conf` via the gateway's
  `/run/opencode-gateway/ctl.sock` admin socket.
- `switch_gateway_mode dev|prod` — flip `OPENCODE_BIN` in
  `/etc/opencode/opencode.cfg` and restart the gateway service so new
  per-user daemons fork from the right binary.
- `status` — gateway service state + mode + per-user daemon list with
  MODE column.

`do_restart` always reloads source first (`do_reload`) when running
from the repo, then evaluates whether the gateway needs to bounce. In
**installed mode** (no source repo present) it cannot rebuild, so it
schedules a detached `daemon-killall` — killing the daemon
synchronously would kill the very process serving the restart
request.

### `/etc/opencode/` configuration

Single source of truth for the gateway. The systemd unit's
`EnvironmentFile=/etc/opencode/opencode.cfg` injects every variable.

- `opencode.cfg` — `OPENCODE_BIN`, `OPENCODE_PORT`,
  `OPENCODE_HOSTNAME`, `OPENCODE_PUBLIC_URL`, `OPENCODE_FRONTEND_PATH`,
  `OPENCODE_LOGIN_HTML`, `OPENCODE_WEBCTL_PATH`,
  `OPENCODE_SERVER_USERNAME`, `OPENCODE_SERVER_HTPASSWD`,
  `GOOGLE_*` OAuth client tuple. Dev/prod mode switching is just
  toggling `OPENCODE_BIN` between
  `bun --conditions=browser .../index.ts` and `/usr/local/bin/opencode`.
- `web_routes.conf` — auto-generated route table consumed by the
  gateway's `load_web_routes()`. Format: `<prefix> <host> <port>
  <owner_uid> [auth]`. Sorted longest-prefix-first at load time.
  Public routes for `/cisopro`, `/linebot`, `/cecelearn`,
  `/lifecollection`, `/warroom`, etc. live here.
- `google-bindings.json` — Google account → opencode user mapping for
  Google Workspace logins (gateway reads
  `GOOGLE_BINDINGS_PATH_DEFAULT="/etc/opencode/google-bindings.json"`).
- `webctl.sh` — installed copy of the orchestration script.
- `tweaks.cfg` — tunable thresholds.

`/run/opencode-gateway/ctl.sock` is the admin Unix socket the gateway
exposes for `webctl.sh publish-route` / `remove-route` to mutate
`web_routes.conf` without restarting the gateway.

### Gateway-as-platform: registered webapps

The gateway's prefix-routed reverse-proxy is **also** the platform any
local dev server can mount itself onto. Registering an app gives it
unified PAM/JWT auth, a stable `/<prefix>` URL, and an entry in the
Admin Panel's webapp list — with zero new infrastructure (no nginx, no
new port wrangling, no auth glue). This is the load-bearing
developer-ergonomics feature of the daemon layer.

Two layers of state, with clear responsibility:

| Layer | File | Owner | Purpose |
|---|---|---|---|
| **User declaration** | `~/.config/web_registry.json` | the registering user | source of truth for `entryName`, `publicBasePath`, `host`, `primaryPort`, `webctlPath`, `enabled`, `access` (`public`/`protected`) |
| **Gateway route table** | `/etc/opencode/web_routes.conf` | written by the gateway / `publish-route` | `<prefix> <host> <port> <owner_uid> [auth]`, longest-prefix-match at `load_web_routes()` |

Flow: user edits `web_registry.json` (or runs the `opencode-web-routes`
skill) → `web-route` HTTP API on the per-user daemon validates and
forwards to `webctl.sh publish-route` → `webctl.sh` talks to
`/run/opencode-gateway/ctl.sock` → gateway rewrites
`/etc/opencode/web_routes.conf` and reloads in-memory. No daemon /
gateway restart required.

Health: `web-route.ts` exposes `tcpProbe()` to TCP-probe each entry's
`host:port` and report alive/dead — surfaced in the Admin Panel and
useful for catching dead dev servers before users hit a 502.

Auth split: when an entry's `access` is `protected`, the gateway
applies its own PAM/JWT verification before forwarding (so the upstream
dev server never sees unauthenticated traffic). `public` entries skip
verification entirely. Mixing `protected` sub-prefixes under a `public`
parent is supported and resolved by longest-prefix-match.

> **Roadmap — remote gateway-to-gateway federation**: a mesh layer
> letting gateways on different hosts forward each other's prefixes
> (so a webapp registered on host A is reachable through host B's
> gateway under a common identity) is currently in design. Open
> questions: trust model (mTLS vs shared JWT signer), prefix-collision
> policy, peering discovery, per-hop auth replay vs delegated
> identity. Proposal will land under `specs/daemon/<remote-gateway>/`
> when drafted.

### Authoritative restart path: `restart_self`

The **only** sanctioned AI self-restart path is the
`system-manager:restart_self` MCP tool
(`packages/mcp/system-manager/src/index.ts` L766). It does a thin
`POST /api/v2/global/web/restart` to the daemon endpoint (already used
by the UI Settings page) carrying the caller's JWT. Optional body:
`{ targets?: ("daemon"|"frontend"|"gateway")[], reason?: string }`.

The route handler lives at
`packages/opencode/src/server/routes/global.ts` L491+. Behavior splits
on `resolveRestartRuntimeMode()`:

- **gateway-daemon mode** (`isGatewayDaemon()` true) — the
  safe-daemon-restart RESTART-001 v2 path:
  1. If `targets` includes `"gateway"`, compile the gateway via
     `compileGatewayForSelfUpdate(repoRoot)`, install via
     `SelfUpdate.runActions()` (privileged copy to
     `/usr/local/bin/opencode-gateway` + `/etc/opencode/webctl.sh`),
     schedule `restart-service opencode-gateway.service` after 300 ms.
  2. Otherwise spawn `webctl.sh restart --graceful` (plus
     `--force-gateway` when requested) with
     `OPENCODE_RESTART_TXID=web-<ts>-<pid>` and
     `OPENCODE_RESTART_ERROR_LOG_FILE=$XDG_RUNTIME_DIR/opencode-web-restart-<txid>.error.log`.
     Smart-skip per layer.
  3. On `webctl` non-zero exit: don't self-terminate. Return
     `WEB_RESTART_FAILED` (or `RESTART_LOCK_BUSY` 409 when stderr
     matches `/already in progress/`) with `webctlExit`, `txid`,
     `errorLogPath`. **System keeps the previous version running**.
  4. On success: respond 200 first, then `setTimeout(300ms,
     Daemon.removeDiscovery + process.exit(0))`. The gateway notices
     the missing socket on the next request and spawns a fresh daemon
     via the self-heal path.
- **legacy mode** (`dev-source` / `dev-standalone` / `service`) —
  spawns `webctl.sh restart --graceful` without the gateway-daemon
  hand-off. Same error contract.

Response on success: `{ ok: true, accepted: true, mode:
"controlled_restart", runtimeMode, probePath: "/api/v2/global/health",
recommendedInitialDelayMs: 1000, fallbackReloadAfterMs: 5000,
recoveryDeadlineMs: 30000 }`. The MCP tool surfaces a textual hint to
the AI: "the daemon will self-terminate after webctl finishes; the
gateway will respawn a fresh daemon on the next request. Expect a
brief window of 503/reconnect."

### Daemon-spawn denylist (Bash tool gate)

`packages/opencode/src/tool/bash.ts` runs every command through
`matchDaemonSpawnDenylist()` before parsing or executing. Four rules
(L34–L39):

| Rule | Pattern (regex prefilter) |
| --- | --- |
| `bun-serve-unix-socket` | `\bbun\b[^\n;|&]*\bserve\b[^\n;|&]*--unix-socket\b` |
| `opencode-serve-or-web` | `\b(?:opencode|\.\/opencode)\s+(?:serve\|web)\b` |
| `direct-daemon-signal` | `\bkill\s+(?:-(?:TERM\|KILL\|9\|15\|HUP\|INT)\s+)?\$?\(\s*(?:cat\s+[^)]*daemon\.lock\|pgrep[^)]*opencode[^)]*)\s*\)` |
| `systemctl-gateway` | `\bsystemctl\s+\w+\s+opencode-gateway\b` |

A match throws `FORBIDDEN_DAEMON_SPAWN` (the bash tool never reaches
`spawn()`); `log.warn("denylist-block rule=<rule>", { argvHash })`
captures a 32-bit FNV-1a hash for telemetry. The 2026-04-20 incident
that motivated this — AI ran `webctl.sh dev-start` via Bash, leaving
an orphan daemon that held the lock and kicked the user out three
times — is the recurrence the denylist plus AGENTS.md rule prevent.
This is "defence-in-depth, not a security boundary"; the hard gate is
AGENTS.md plus code review.

### Gateway self-heal (RESTART-003 / 004)

Triggered when `find_or_create_daemon` cannot adopt:

1. Read `~/.config/opencode/daemon.lock` JSON; if `pid` is alive and
   `/proc/<pid>` belongs to the target uid → SIGTERM, 1 s `waitpid`,
   SIGKILL escalation. Logged as
   `[WARN] orphan-detected uid=<uid> holderPid=<pid>` then
   `[INFO] orphan-cleanup uid=<uid> holderPid=<pid> result=<exited|killed> waitedMs=<n>`.
2. `unlink(socket_path)` to clear stale binding.
3. `mkdir -p /run/user/<uid>/opencode` with `chown` + `chmod 0700`
   when missing (parent `/run/user/<uid>` too if the tmpfs cleared
   it). Logged as `[INFO] runtime-dir-created path=<p> uid=<uid>
   mode=0700`.
4. Fork + setuid + exec the new daemon.

User session (JWT cookie) survives — the SSE/HTTP client just hits a
brief 503 window then reconnects (DD-7: front-end's existing reconnect
logic owns this; no new layer).

### Multi-user onboarding hooks

Per the runtime conventions captured in MEMORY.md and exercised by
production:

- Gateway auto-creates `/run/user/<uid>/opencode/` on first request
  for that uid — **no `/tmp` fallback** when the runtime path is
  resolvable (the tmpdir branch only fires when neither
  `/run/user/<uid>/` nor `$XDG_RUNTIME_DIR` is present, which on
  systemd hosts means a manual override).
- Login redirect clears `localStorage` on cross-user switch to avoid
  cross-user state pollution (a separate user's account view should
  never be reused after re-auth).
- System accounts (`pkcs12`, `cece`, `rooroo`, `liam`, `yeatsluo`,
  `chihwei`) all share one gateway process and one
  `/etc/opencode/google-bindings.json` mapping; their per-user daemons
  are isolated by uid + socket path.
- The legacy `opencode` system user (uid 997) home was deleted and
  the legacy unit disabled; the user account itself still exists for
  historical fs ownership but is no longer a daemon owner.

### `AGENTS.md` lifecycle authority

Project `AGENTS.md` "Daemon Lifecycle Authority" section is the
authoritative description of the rule. Quoted constraints (see
`/home/pkcs12/projects/opencode/AGENTS.md` for the full text):

> AI 禁止自行 spawn / kill / restart opencode daemon 或 gateway 行程。
> 唯一合法的自重啟路徑是呼叫 `system-manager:restart_self` MCP tool
> （內部 POST `/api/v2/global/web/restart`，由 gateway + `webctl.sh`
> 負責 rebuild + install + restart 的 orchestration）。

> 違規後果：Bash tool 直接拋 `FORBIDDEN_DAEMON_SPAWN`，不執行；
> gateway log 同步寫 `denylist-block rule=...`。

> 需要改 code 後讓它生效？呼叫 `restart_self`；webctl.sh 會 smart-detect
> dirty 層（daemon / frontend / gateway）並只 rebuild 變動部分。
> `targets: ["gateway"]` 會附 `--force-gateway` 讓 systemd respawn
> gateway 本體（期間所有使用者斷線 3-5s）。

> rebuild 失敗怎麼辦？`restart_self` 回 5xx 並帶 `errorLogPath`；
> 系統維持舊版本可用。AI 讀 log、修正、再呼叫。絕不嘗試繞過。

The same file additionally enforces "Web Runtime 單一啟動入口
(Fail-Fast)": only `./webctl.sh dev-start` / `dev-refresh` may start
the runtime; direct `bun ... opencode ... web` / `opencode web`
invocations are forbidden.

## Code anchors

Gateway (C):
- `daemon/opencode-gateway.c` — full gateway. `resolve_runtime_dir()`
  ~L715, `ensure_daemon_running()` ~L1491, `load_web_routes()` ~L225,
  `CTL_SOCK_PATH` admin socket ~L192.
- `daemon/opencode-gateway.service` — systemd unit
  (`EnvironmentFile=/etc/opencode/opencode.cfg`).
- `daemon/opencode-user@.service` — optional per-user unit.
- `daemon/login.html` — login page returned for unauthenticated GET.
- `daemon/test-orphan-cleanup.c` — orphan-cleanup unit test.

Daemon (TypeScript):
- `packages/opencode/src/cli/cmd/serve.ts` — `serve --unix-socket`
  daemon entry point.
- `packages/opencode/src/server/server.ts` — `Server.listen` and
  `Server.listenUnix` lifecycle.
- `packages/opencode/src/server/daemon.ts` — `Daemon` namespace
  (discovery/adopt/spawn, `writeDiscovery`, `readDiscovery`,
  `removeDiscovery`, `spawnOrAdopt`).
- `packages/opencode/src/daemon/gateway-lock.ts` — JSON PID lock at
  `~/.config/opencode/daemon.lock` with `process.kill(pid, 0)`
  liveness.
- `packages/opencode/src/server/routes/global.ts` — `/web/restart`
  route handler (~L491). `resolveRestartRuntimeMode` L24,
  `isGatewayDaemon` L34.
- `packages/opencode/src/server/routes/web-route.ts` — gateway
  registered-webapps API. `registryPath()` L43, `readRegistry()` L48,
  `tcpProbe()` L55, webctl runner L76, ctl.sock client L97, route
  registration handlers ~L180+, health endpoint ~L253.
- `packages/opencode/src/cli/cmd/tui/thread.ts` — TUI adopt /
  `--attach` strict path.

Tool gate:
- `packages/opencode/src/tool/bash.ts` — `DAEMON_SPAWN_DENYLIST` L34,
  `matchDaemonSpawnDenylist` L51, throw site L126.
- `packages/opencode/src/tool/bash-denylist.test.ts` — 14-case
  coverage for the four rules plus passthrough.

MCP tool:
- `packages/mcp/system-manager/src/index.ts` — `restart_self` tool
  declaration L766, handler L1799 (POST `/global/web/restart` thin
  shim).

Orchestration:
- `webctl.sh` (repo root + installed at `/etc/opencode/webctl.sh`) —
  2906 LOC. `do_restart` L1507, `do_restart_worker` L1624,
  `do_dev_start` L1162, `do_dev_stop` L1255, `do_flush` L1394,
  `do_status` L1757, `do_build_frontend` L1934, `do_build_binary`
  L2035, `do_compile_gateway` L2221, `do_daemon_killall` L2503,
  `do_publish_route` L2709, `switch_gateway_mode` L2276.

Config:
- `/etc/opencode/opencode.cfg` — runtime SSOT (port, BIN, frontend
  path, htpasswd, Google OAuth tuple).
- `/etc/opencode/web_routes.conf` — gateway-managed route table.
- `/etc/opencode/google-bindings.json` — Google account → uid map.
- `/etc/opencode/tweaks.cfg` — tunables.

Tests (representative):
- `daemon/test-orphan-cleanup.c` — TV-2 SIGKILL escalation.
- `packages/opencode/src/tool/bash-denylist.test.ts` — TV-3/TV-4
  denylist coverage.
- `packages/opencode/src/daemon/gateway-lock.test.ts` — PID lock
  semantics.
- `packages/opencode/src/server/server.test.ts` — listen lifecycle.

## Notes

### Verification matrix (from `safe-daemon-restart` handoff)

Captured 2026-04-21 on `test/safe-daemon-restart` (main + 6 commits,
merged via `a17d963bb`). Gateway rebuilt to 102 064 bytes,
`sudo install -m 4755 -o root daemon/opencode-gateway
/usr/local/bin/`, `systemctl restart opencode-gateway` → active. Live
end-to-end log excerpt:

```
Apr 21 01:45:42 [WARN ] orphan-detected uid=1000 holderPid=945205 username=pkcs12 — cleaning up before spawn
Apr 21 01:45:42 [INFO ] orphan-cleanup uid=1000 holderPid=945205 result=exited waitedMs=50 username=pkcs12
Apr 21 01:45:42 [INFO ] runtime-dir-created path=/run/user/1000/opencode uid=1000 mode=0700
Apr 21 01:45:42 [INFO ] spawning daemon for pkcs12 (uid 1000) socket='/run/user/1000/opencode/daemon.sock'
Apr 21 01:45:42 [INFO ] forked daemon child for pkcs12: pid=945805
```

Setup: killed prior daemon, `sudo rm -rf /run/user/1000/opencode/`,
`curl /api/v2/global/health` → 200. User session continuous; no JWT
clear, no login redirect. Contrast with the 2026-04-20 failure mode
which looped `waitpid ECHILD` until JWT cleared.

### Deferred items from `daemonization`

Original `daemonization/spec.md` Verification Matrix marks several
rows as `Deferred`: V4 SSE forwarding through splice, V5 WebSocket
upgrade through splice, V6 multi-user isolation (alice/bob), V7
concurrent-login stress, V8 WSL2 V1–V3 rerun. These represent
breadth-of-coverage holes, not behavioural unknowns; the splice path
is L4-transparent so SSE / WS forwarding works in practice but lacks
recorded acceptance. Multi-user isolation works in production (six
system accounts share the gateway daily) but no synthetic
adversarial test was authored.

### Drift note vs `daemonization/spec.md`

The legacy `specs/_archive/daemonization/spec.md` (2026-03-28 drift note) is
**not** the full daemonization SSOT by itself. Current daemonization
truth lives in this entry, `specs/architecture.md`, the gateway C
source, `daemon.ts`, `thread.ts`, and `server.ts`. The legacy spec
remains useful as the privileged-edge baseline (PAM thread, JWT
persistence, splice proxy, reverse-proxy cookie strategy) but
TypeScript-side daemonization-v2 behavior — TUI always-attach via
`Daemon.spawnOrAdopt()`, per-user discovery/adopt semantics,
`Server.listenUnix()` start/cleanup — only appears in code, not in
that document.

### Open / partial work

- Gateway HTTP endpoint admin auth scope (`safe-daemon-restart` O1) —
  resolved in code by reusing daemon-side JWT (the `/web/restart`
  endpoint lives on the daemon, not the gateway). No separate admin
  scope.
- 503 vs queue during restart window (`safe-daemon-restart` O2) —
  current code returns 200 from the restart call and lets the
  client's reconnect path absorb the brief unavailability. No 503
  hold-until-spawn implemented.
- Privileged `compileGatewayForSelfUpdate` + `SelfUpdate.runActions`
  path requires sudoer privilege; failure returns
  `SELF_UPDATE_REQUIRES_SUDOER` (HTTP 403). On hosts without that
  privilege the `targets: ["gateway"]` flow degrades to "must run
  webctl manually as root".

## Sub-packages

- [self-restart-handover/](./self-restart-handover/) (shipped
  2026-05-05) — durable handover checkpoint written before
  `system-manager:restart_self` orchestration interrupts the
  socket. Records redacted reason / handover / session metadata
  plus validation next steps; socket close stays
  unknown/pending until health/log evidence confirms recovery.

### Related entries

- [meta/](../meta/README.md) — config-management surface; `opencode.cfg`,
  `tweaks.cfg`, `mcp-apps.json`, the SYSTEM.md / AGENTS.md split.
- [webapp/](../webapp/README.md) — web frontend; served through the gateway
  via `/etc/opencode/web_routes.conf` and `OPENCODE_FRONTEND_PATH`.
- [provider/](../provider/README.md) — provider runtime; lives inside the
  per-user daemon process and depends on the daemon lifecycle
  authority defined here for any "restart provider" semantics.
