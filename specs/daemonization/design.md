# Daemonization Design — C Root Gateway Splice Proxy

## Context

C root gateway (`daemon/opencode-gateway.c`) 是 daemonization 的 privileged edge：PAM auth、public TCP port、fork+setuid+exec、splice proxy。經 7 個 session 的迭代，從僅通過編譯的 prototype 發展為可在 reverse proxy 後正確運作的 production gateway。

## Goals / Non-Goals

**Goals:**
- Non-blocking event loop (thread-per-auth PAM)
- Correct HTTP request buffering (TCP segment accumulation)
- Tagged epoll fd identification + proper connection lifecycle
- JWT persistence + login rate limiting
- Reverse proxy (nginx HTTP/2) compatibility
- systemd service integration with dev/prod mode switching
- Strict TUI --attach contract (no auto-spawn fallback)
- XDG path hygiene for per-user daemon context

**Non-Goals:**
- Application-layer reverse proxy (maintain L4 splice)
- Rewrite entire daemonization architecture
- Frontend UI changes
- Cross-machine TUI attach

## Decisions

### DD-1: Event loop — thread-per-auth

PAM is inherently blocking. pthread + eventfd notification. PAM is low-frequency (login only), no thread explosion risk. Main epoll loop stays single-threaded.

### DD-2: HTTP buffering — per-connection state machine

Accept → non-blocking fd → epoll → per-connection PendingRequest (8KB buffer) → accumulate until `\r\n\r\n` → route. Timeout 30s, oversize 8KB → error response.

### DD-3: epoll fd identification — tagged EpollCtx

Discriminated union: `{ enum type; union { PendingRequest*, Connection* } }`. 5 types: LISTEN, PENDING, SPLICE_CLIENT, SPLICE_DAEMON, AUTH_NOTIFY. Event dispatch by type.

### DD-4: Connection lifecycle

- `close_conn()`: EPOLL_CTL_DEL → close → g_nconns-- → slot release
- `closed` flag: same-round epoll guard
- Connection slot: MAX_CONNS=1024, scan-based (sufficient for scale)

### DD-5: JWT persistence — file-backed

`/run/opencode-gateway/jwt.key` (root-owned, 0600). Load on start, generate if missing. Survives restart. Rotation = delete + restart.

### DD-6: Login rate limiting — per-IP sliding window

Hash table mod 256. 5 failures / 60s → 429. Success clears counter. No persistence.

### DD-7: WSL2 environment adaptation

Runtime path detection: `/run/user/<uid>/` → `$XDG_RUNTIME_DIR` → `/tmp/opencode-<uid>/` (mkdir 700). Log selected path. PAM probe at startup with fail-fast.

### DD-8: OPENCODE_BIN — secure argv

`parse_opencode_argv()` pre-splits into argv array before fork. Child uses `execvp`. No `sh -c` after setuid.

### DD-9: Keep-alive + splice safety (resolved)

Splice proxy per-identity. HTTP/1.1 keep-alive bound to same daemon. Cookie theft is TLS concern. No per-request JWT re-validation needed at splice layer.

### DD-10: Baseline preservation

JWT claim validation, identity routing, daemon lifecycle (adopt/spawn/wait) from Session 3 hardening preserved as baseline.

### DD-11: Reverse proxy cookie strategy

nginx HTTP/2→HTTP/1.1 lowercases all headers. Two fixes:
1. **Case-insensitive cookie parsing**: search for both `\r\nCookie:` and `\r\ncookie:`
2. **JS client-side cookie**: login success returns HTML with `document.cookie='oc_jwt=...'` + `window.location.replace('/')` instead of `Set-Cookie` header (bypasses nginx response header stripping)
3. **Auth route priority**: `POST /auth/login` routed before JWT check (prevents proxying auth to daemon which returns 404)

### DD-12: Gateway auth-owned routes

Gateway-owned routes handled before JWT verification:
- `POST /auth/login` → PAM auth → JWT issue
- `GET /api/v2/global/health` → unauthenticated health check
- All other routes → JWT check → splice to daemon

### DD-13: systemd + webctl integration

- Gateway = permanent systemd service (`opencode-gateway.service`)
- Single cfg: `/etc/opencode/opencode.cfg` (OPENCODE_BIN, GATEWAY_PORT, LOGIN_HTML, etc.)
- Dev mode: `OPENCODE_BIN="bun --conditions=browser /path/to/index.ts"`
- Prod mode: `OPENCODE_BIN="/usr/local/bin/opencode"`
- `switch_gateway_mode()`: update cfg → restart service → kill per-user daemons (respawn on next request)
- `do_restart()`: auto-detect mode → rebuild frontend/gateway/binary as needed → restart
- `do_status()`: gateway service status + mode + per-user daemon list with MODE column

### DD-14: Per-user daemon process model

- Gateway fork+setsid spawns daemon → child detached from gateway process tree
- Daemon persists until killed; auto-respawns on next authenticated request
- webctl flush excludes known daemon PIDs via daemon.json discovery scan
- `--attach` fail-fast: TUI only connects to existing daemon, never auto-spawns

### DD-15: Memory MCP XDG path

Memory MCP path: `~/.local/share/opencode/memory/<project-id>/project.jsonl` instead of `<worktree>/.opencode/memory/`. Prevents `~/.opencode/` creation when daemon cwd is user home (non-git directory).

## Request Lifecycle (Final State)

```
Browser → nginx HTTPS → TCP :1080
  → epoll: EPOLLIN on listen_fd
    → accept4() → non-blocking client_fd → PendingRequest → epoll EPOLL_PENDING

  → epoll: EPOLLIN on pending client_fd
    → accumulate → header complete → parse
    → POST /auth/login → auth route priority (before JWT check)
      → rate limit check → spawn PAM thread → eventfd → JWT sign → JS cookie response
    → has oc_jwt cookie → case-insensitive parse (Cookie: / cookie:)
      → jwt_verify → username + uid → find_or_create_daemon → ensure_running
      → connect_unix → start_splice_proxy → forward buffered request
      → register EpollCtx (SPLICE_CLIENT + SPLICE_DAEMON)
    → no JWT → serve login page (OPENCODE_LOGIN_HTML)
    → GET /api/v2/global/health → unauthenticated response

  → epoll: EPOLLIN on splice fd
    → check EpollCtx.type → directional splice only

  → epoll: EPOLLHUP/EPOLLERR
    → EPOLL_CTL_DEL both → close all → g_nconns-- → slot release
```

## Critical Files

- `daemon/opencode-gateway.c` — gateway implementation
- `daemon/opencode-gateway.service` — systemd unit
- `daemon/opencode-user@.service` — optional per-user unit
- `daemon/login.html` — login page
- `templates/system/opencode.cfg` — config template
- `webctl.sh` — mode switching, restart, status
- `packages/opencode/src/cli/cmd/tui/thread.ts` — --attach fail-fast
- `packages/opencode/src/config/config.ts` — memory MCP XDG path
- `packages/opencode/src/mcp/index.ts` — memory dir mkdir
- `packages/opencode/src/server/daemon.ts` — discovery/spawn
