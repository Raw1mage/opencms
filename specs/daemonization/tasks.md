# Daemonization Tasks — Completion Record

All phases completed across Sessions 1-7. This document serves as the finalized task record.

---

## Phase 1: Event Loop Architecture Fix (REQ-1, REQ-2) — COMPLETED

- [x] 1.1 Non-blocking accept path: accept4() → PendingRequest → epoll
- [x] 1.2 PendingRequest struct: per-connection 8KB read buffer + buf_len + accept_time
- [x] 1.3 Buffered HTTP accumulation: EPOLLIN → read → check `\r\n\r\n` → route or 400/408
- [x] 1.4 Thread-per-auth PAM: pthread + eventfd notification
- [x] 1.5 Verified: epoll loop not blocked during PAM auth

## Phase 2: epoll & Connection Lifecycle Fix (REQ-3, REQ-4) — COMPLETED

- [x] 2.1 EpollCtx tagged struct: 5 types (LISTEN/PENDING/SPLICE_CLIENT/SPLICE_DAEMON/AUTH_NOTIFY)
- [x] 2.2 epoll registration refactored per type
- [x] 2.3 Directional splice: event → EpollCtx.type → single direction only
- [x] 2.4 close_conn(): EPOLL_CTL_DEL → close → g_nconns--
- [x] 2.5 Closed flag guard for same-round epoll events

## Phase 3: Security Hardening (REQ-5, REQ-6, REQ-10.2) — COMPLETED

- [x] 3.1 JWT file-backed persistent secret (`/run/opencode-gateway/jwt.key`)
- [x] 3.2 Per-IP rate limiting (5/60s → 429)
- [x] 3.3 `parse_opencode_argv()` + `execvp` (no sh -c)

## Phase 4: Environment Adaptation (REQ-10) — COMPLETED

- [x] 4.1 Runtime path detection: `/run/user/<uid>` → `$XDG_RUNTIME_DIR` → `/tmp/opencode-<uid>/`
- [x] 4.2 PAM availability probe at startup

## Phase 5: Runtime Verification — PARTIAL

- [x] 5.1 V1 — Compile gate PASSED
- [x] 5.2 V2 — Static review PASSED (7 invariants)
- [x] 5.3 V3 — Single-user runtime PASSED (JWT → daemon → splice → frontend)
- [x] 5.3b V3b — Reverse proxy end-to-end PASSED (crm.sob.com.tw → nginx → gateway)
- [ ] 5.4 V4 — SSE forwarding (deferred: requires SSE-capable test)
- [ ] 5.5 V5 — WebSocket upgrade (deferred: requires WebSocket test)
- [ ] 5.6 V6 — Multi-user isolation (deferred: requires multi-user environment)
- [ ] 5.7 V7 — Stress testing (deferred: requires load test tooling)
- [ ] 5.8 V8 — WSL2 environment (deferred: requires WSL2 without systemd)

## Phase 6: Reverse Proxy Compatibility (REQ-12) — COMPLETED

- [x] 6.1 Case-insensitive cookie header parsing
- [x] 6.2 Auth route priority before JWT verification
- [x] 6.3 JS client-side cookie (document.cookie) instead of Set-Cookie header
- [x] 6.4 Unauthenticated health endpoint for LB probes

## Phase 7: systemd & webctl Integration (REQ-13) — COMPLETED

- [x] 7.1 Gateway systemd service file (opencode-gateway.service)
- [x] 7.2 Config template with gateway section (OPENCODE_BIN, GATEWAY_PORT, LOGIN_HTML)
- [x] 7.3 `switch_gateway_mode()` — update cfg + restart service + kill per-user daemons
- [x] 7.4 `do_restart()` — auto-detect mode + rebuild + restart
- [x] 7.5 `do_status()` — gateway mode + per-user daemon list with MODE column

## Phase 8: Client-Side Hardening (REQ-14, REQ-15) — COMPLETED

- [x] 8.1 `--attach` fail-fast: no auto-spawn fallback
- [x] 8.2 Memory MCP XDG path: `~/.local/share/opencode/memory/<project-id>/`
- [x] 8.3 webctl flush daemon exclusion via daemon.json discovery

## Phase 9: Documentation Sync — COMPLETED

- [x] 9.1 Event log updated (docs/events/event_20260319_daemonization.md)
- [x] 9.2 Architecture sync (specs/architecture.md)
- [x] 9.3 Spec formalized to specs/daemonization/

---

## Runtime Bug Fixes (Session 5-7)

| Bug | Root Cause | Fix |
|-----|-----------|-----|
| Deadline overflow in wait_for_daemon_ready | `timeout_ms * 1e6` exceeds tv_nsec range | Split into tv_sec + tv_nsec |
| Child missing OPENCODE_FRONTEND_PATH | Env not forwarded from gateway | Added env forwarding |
| Cookie not sent after login (reverse proxy) | nginx HTTP/2 lowercases headers; gateway searched `Cookie:` only | Case-insensitive search |
| 404 after login with existing JWT | POST /auth/login caught by JWT check, proxied to daemon | Auth route priority before JWT |
| Set-Cookie stripped by nginx | nginx modifies response headers | JS document.cookie approach |
| `~/.opencode/` recreated by daemon | Memory MCP mkdir with worktree=home | XDG data path with project ID |
| webctl flush kills per-user daemons | Gateway setsid() detaches child from tree | Exclude daemon.json PIDs |
| pkill pattern truncation | Process name >15 chars | Use pkill -f |
