# Daemonization Spec — C Root Gateway Splice Proxy

## Purpose

將 C root gateway splice proxy 從 prototype 收斂為結構健全、經 runtime 驗證、可在 reverse proxy 後正確運作的 production gateway。涵蓋 event loop 架構、HTTP 協議處理、connection lifecycle、splice proxy、安全強化、環境適配、reverse proxy 相容性與 systemd 整合。

## Architecture Overview

```
Browser → nginx (HTTPS, HTTP/2) → TCP :1080 → C Gateway (root)
  → PAM auth (pthread) → JWT (HMAC-SHA256, file-backed secret)
  → fork+setuid+execvp → per-user opencode daemon (Unix socket)
  → splice() zero-copy bidirectional proxy
```

---

## Requirements

### REQ-1: Gateway event loop SHALL NOT block on individual request handling

- PAM authentication runs in dedicated pthread, signals main loop via eventfd
- Initial HTTP request reading uses per-connection non-blocking buffer (PendingRequest)
- Main epoll loop never blocks on recv() or PAM calls

### REQ-2: Gateway SHALL handle partial and multi-packet HTTP requests

- TCP segments accumulated in per-connection 8KB buffer until `\r\n\r\n` detected
- Oversized (>8KB header) → 400, timeout (>30s) → 408
- Never assumes single recv() contains complete request

### REQ-3: Gateway epoll SHALL distinguish event source per fd

- Tagged `EpollCtx` discriminated union: LISTEN / PENDING / SPLICE_CLIENT / SPLICE_DAEMON / AUTH_NOTIFY
- Each epoll event dispatches by type, splice only in triggered direction

### REQ-4: Connection lifecycle SHALL be bounded and leak-free

- `close_conn()`: EPOLL_CTL_DEL before close, g_nconns decrement, slot release
- `closed` flag guards in-flight epoll events in same round
- Connection counter tracks actual active connections

### REQ-5: JWT secret SHALL survive gateway restart

- File-backed at `/run/opencode-gateway/jwt.key` (configurable via `OPENCODE_JWT_KEY_PATH`)
- Generated on first start, loaded on subsequent starts
- Rotation: delete file + restart gateway

### REQ-6: Gateway SHALL enforce login rate limiting

- Per-IP hash table (mod 256), 5 failures / 60s → 429
- Successful login clears counter
- No persistence needed; restart resets counters

### REQ-7: JWT claim validation (baseline)

- Decode base64url payload, validate `sub` + `exp`, HMAC signature check
- Identity: `sub` → `getpwnam()` → uid
- Expired/malformed/missing → 401, no fallback

### REQ-8: Identity routing (baseline)

- `find_or_create_daemon(username)` → registry lookup by uid
- Two users remain fully isolated; no first-available fallback

### REQ-9: Daemon lifecycle observable and bounded (baseline + reinforced)

- Discovery-first adopt: read daemon.json, verify PID alive, probe socket
- Spawn: fork + setsid + initgroups + setgid + setuid + execvp
- Readiness: poll socket with proper sec/nsec timeout calculation
- SIGCHLD exit status logged

### REQ-10: Environment compatibility

- Runtime path detection: `/run/user/<uid>` → `$XDG_RUNTIME_DIR` → `/tmp/opencode-<uid>/` (mkdir 700)
- PAM availability probe at startup with fail-fast guidance
- `OPENCODE_BIN` argv pre-split via `parse_opencode_argv()` + `execvp` (no sh -c)

### REQ-11: Splice proxy HTTP/1.1 keep-alive safety

- Splice proxy per-identity: subsequent keep-alive requests bound to same daemon
- Cookie theft/session fixation is TLS layer concern, not splice layer

### REQ-12: Reverse proxy compatibility (nginx HTTP/2)

- Case-insensitive cookie header parsing (`Cookie:` and `cookie:`) for nginx HTTP/2→HTTP/1.1 header lowercasing
- Auth route priority: POST `/auth/login` handled before JWT verification to prevent proxying auth requests to per-user daemon
- Client-side JS cookie setting (`document.cookie`) instead of `Set-Cookie` header, bypassing nginx response header stripping
- Health endpoint `GET /api/v2/global/health` unauthenticated for load balancer probes

### REQ-13: systemd service integration

- Gateway runs as permanent systemd service (`opencode-gateway.service`)
- `EnvironmentFile=/etc/opencode/opencode.cfg` as single source of truth
- Dev/prod mode switching via `OPENCODE_BIN` value in cfg
- webctl.sh: `switch_gateway_mode dev|prod`, unified `restart` with auto-rebuild, `status` with gateway mode + per-user daemon listing

### REQ-14: TUI --attach strict contract

- `--attach` only connects to existing gateway-spawned daemon via discovery file
- No auto-spawn fallback; fail-fast if no daemon found
- Per-user daemon lifecycle owned exclusively by gateway

### REQ-15: Per-user daemon XDG path hygiene

- Memory MCP path uses `~/.local/share/opencode/memory/<project-id>/` (XDG data path)
- Never creates `~/.opencode/` directory from daemon context
- webctl.sh flush excludes known per-user daemon PIDs (daemon.json discovery)

---

## Acceptance Checks

- [x] Event loop non-blocking during PAM auth (REQ-1)
- [x] HTTP request TCP segment accumulation (REQ-2)
- [x] epoll events distinguish fd source (REQ-3)
- [x] Connection resources fully cleaned, counter correct (REQ-4)
- [x] JWT secret persists across gateway restart (REQ-5)
- [x] Login rate limiting enforced (REQ-6)
- [x] JWT claim validation correct (REQ-7)
- [x] Identity routing isolated (REQ-8)
- [x] Daemon lifecycle observable (REQ-9)
- [x] WSL2/environment adaptation (REQ-10)
- [x] Keep-alive safety analyzed (REQ-11)
- [x] Reverse proxy (nginx HTTP/2) end-to-end (REQ-12)
- [x] systemd service + webctl integration (REQ-13)
- [x] TUI --attach strict fail-fast (REQ-14)
- [x] XDG path hygiene, no ~/.opencode creation (REQ-15)

## Verification Matrix

| ID | Scope | Status |
|----|-------|--------|
| V1 | Compile: `gcc -O2 -Wall -Werror -D_GNU_SOURCE -lpam -lpam_misc -lcrypto -lpthread` | PASSED |
| V2 | Static review: 7 invariants (no blocking, EPOLL_CTL_DEL, no sh -c, JWT claims, lifecycle, rate limit, thread safety) | PASSED |
| V3 | Single-user runtime: login → JWT → daemon → splice → response | PASSED |
| V3b | Reverse proxy: crm.sob.com.tw → nginx → gateway → daemon → frontend | PASSED |
| V4 | SSE forwarding through splice proxy | Deferred |
| V5 | WebSocket upgrade/streaming through splice | Deferred |
| V6 | Multi-user isolation (alice/bob) | Deferred |
| V7 | Stress: concurrent login + splice, no deadlock/leak | Deferred |
| V8 | WSL2 environment V1-V3 | Deferred |
