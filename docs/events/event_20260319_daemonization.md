# Event: Daemonization — TUI Thin Client + Per-user Daemon

**Date**: 2026-03-19
**Branch**: `daemonization` (beta repo, base: `a01e8906f2` = cms latest)
**Spec**: `specs/20260319_tui-thin-client-attach/`

## 需求

將 opencode 從「TUI 包含 Worker thread 內建 server」架構，重構為「per-user daemon + TUI thin client」架構。消除 sudo-n 全域特權風險，讓 TUI 和 webapp 共享同一 per-user daemon。

## 範圍

### IN
- Phase β: Per-user daemon mode (`--unix-socket`, discovery file, PID file)
- Phase γ: TUI Attach Mode (`--attach` flag, auto-discover, Unix socket client)
- Phase ε: Account Bus Events (account.added/removed/activated + mutex)
- Phase α: C Root Daemon (epoll, PAM, splice proxy)
- Phase δ: Security Migration (移除 sudo-n / linux-user-exec)
- Phase ζ/η/θ: SSE Event ID + Payload + Performance Hardening
- Phase ω: webctl.sh + architecture.md sync + regression

### OUT
- Bun runtime fork/修改
- Webapp 前端 UI 變更
- TUI 前端 UI 變更（Ink/React 渲染層）
- PTY session 孤兒回收
- 跨機器 TUI attach

## 任務清單

見 `specs/20260319_tui-thin-client-attach/tasks.md`

## Key Decisions

- **base 防呆**：beta repo 的 `origin` 已指向 main repo，`origin/cms` 作為防呆基準，branch `daemonization` 從 `a01e8906f2` 建立。
- **Phase 執行順序**：β → γ → ε（可與 α 平行）→ δ → ζ/η/θ → ω
- **Discovery file 路徑**：`$XDG_RUNTIME_DIR/opencode/daemon.json`（fallback: `/tmp/opencode-{uid}/daemon.json`）
- **Unix socket 路徑**：`$XDG_RUNTIME_DIR/opencode/daemon.sock`
- **Bun.serve 型別**：Unix socket 模式需 double-cast `as unknown as Parameters<typeof Bun.serve>[0]`（TCP/Unix overload 不重疊）
- **Gateway 設計**：additive deployment option，不修改現有 dev-start/web-start 命令

## Debug Checkpoints

### Baseline
- 症狀：N/A（新功能實作）
- 現況：TUI 使用 Worker thread 內建 server；無 daemon 模式
- 影響範圍：serve.ts, server.ts, tui/thread.ts, account/index.ts, bus/index.ts, provider.ts, bash.ts, shell-executor.ts, pty/index.ts, linux-user-exec.ts, routes/global.ts

### Instrumentation Plan
- β.6: `opencode serve --unix-socket /tmp/test.sock` + `curl --unix-socket` 驗證
- γ.8: `bun run dev` 無 --attach → 維持現有行為
- γ.8: `opencode --attach` → discover → attach

### Execution

**Session 1 (2026-03-19)**:
- Phase β: daemon.ts 建立完成，server.ts 新增 `listenUnix()`，serve.ts 新增 `--unix-socket` CLI 選項
- Phase γ: thread.ts 新增 `--attach`、`createUnixFetch`、`createUnixEventSource`，discoverDaemon 透過 `Daemon.readDiscovery()`
- Phase ε: bus/index.ts 新增 account event types，account/index.ts 加入 withMutex + bus publish
- Phase α: `daemon/opencode-gateway.c` (~600 行)，PAM + JWT + epoll + splice proxy，gcc 編譯成功 (27KB)
- Phase δ: bash.ts/shell-executor.ts/pty/index.ts 移除 sudo invocation，linux-user-exec.ts 保留 utility functions，opencode-run-as-user.sh 刪除
- Phase ζ: global.ts 新增 SSE ring buffer (MAX=1000) + event ID + Last-Event-ID catch-up
- Phase θ: provider.ts 新增 SDK LRU cache (sdkSet, MAX=50)，server.ts idleTimeout 120s
- Phase ω: webctl.sh 新增 compile_gateway/start_gateway/stop_gateway，install.sh 新增 gateway unit 安裝

**Session 2 (2026-03-19)** — Daemon Auto-Spawn + Gateway Adopt:
- γ.4b 改為 auto-spawn：`--attach` 找不到 daemon → `Daemon.spawn()` → detached child `opencode serve --unix-socket` → poll discovery file → attach
- γ.4e 新增 `Daemon.spawn()`：resolve executable（OPENCODE_BIN > Bun.argv[0]）、detached Bun.spawn + unref、poll readDiscovery 150ms interval、timeout 10s
- α.6e 新增 `try_adopt_from_discovery()`：C gateway 在 `ensure_daemon_running()` fork/exec 前，先讀 `/run/user/<uid>/opencode/daemon.json`（fallback `/tmp/opencode-<uid>/daemon.json`），若 PID alive 則 adopt 進 registry
- Architecture sync：新增 "Daemon Coordination (Discovery-First)" 章節

**Session 3 (2026-03-23)** — Gateway Hardening Plan Execution:
- α.h1 JWT verify 從 prototype 改為實際 decode+validate：新增 base64url decode、payload JSON extract、`sub`/`exp` 驗證；identity strategy 採 `sub -> getpwnam() -> uid`
- α.h2 後續 authenticated request routing 不再走 `g_daemons[0]` demo path，改為 `find_or_create_daemon(username)` + `ensure_daemon_running(d)` + verified identity check
- α.h3 unauthorized / malformed / expired token path 明確回 401，不再容忍簽章通過但 claims 未驗證的請求
- α.h4 lifecycle hardening：新增 stale discovery/socket cleanup、connectable socket probe、child exit before readiness 檢查、timeout observability、ready-state revalidation
- α.h5 compile gate：`gcc -O2 -Wall -D_GNU_SOURCE` 可成功編譯；舊的 prototype markers（`g_daemons[0]` demo routing / JWT TODO / `/tmp` discovery fallback）已從當前 gateway code 移除

**Session 4 (2026-03-23)** — Structural Hardening Build (plan `plans/20260323_c-root-daemon-splice-proxy/`):
- Phase 1: Non-blocking event loop — replaced blocking recv()+PAM in accept path with `PendingRequest` HTTP accumulation buffer (8KB per-connection, `\r\n\r\n` detection, 30s timeout, oversize guard)
- Phase 1: Thread-per-auth PAM — `pthread` + `eventfd` notification; auth job queue with mutex; main loop drains completions via `ECTX_AUTH_NOTIFY`
- Phase 2: Tagged `EpollCtx` discriminated union — 5 types (LISTEN/PENDING/SPLICE_CLIENT/SPLICE_DAEMON/AUTH_NOTIFY); directional splice (one direction per event)
- Phase 2: Connection lifecycle fix — `EPOLL_CTL_DEL` before `close()`, `closed` flag guard, proper `g_nconns` decrement, slot release
- Phase 3: JWT file-backed persistent secret (`/run/opencode-gateway/jwt.key`, configurable via `OPENCODE_JWT_KEY_PATH`)
- Phase 3: Per-IP rate limiting (hash table mod 256, 5 failures/60s → 429, success clears counter)
- Phase 3: `parse_opencode_argv()` pre-split + `execvp()` — eliminates `sh -c` after setuid
- Phase 4: `resolve_runtime_dir()` — `/run/user/<uid>` → `$XDG_RUNTIME_DIR` → `/tmp/opencode-<uid>/` (mkdir 700); all hardcoded `/run/user/` paths replaced
- Phase 4: PAM availability probe at startup — `pam_start("login", ...)` check, fail-fast with guidance
- Phase 5: V1 compile gate PASSED (`gcc -O2 -Wall -Werror -D_GNU_SOURCE -lpam -lpam_misc -lcrypto -lpthread`)
- Phase 5: V2 static review PASSED (7 invariants: no blocking in loop, EPOLL_CTL_DEL before close, no sh -c, JWT claims complete, connection lifecycle, rate limiting, thread safety)
- Phase 5: V3-V8 runtime verification deferred (requires running gateway + opencode backend environment)
- `webctl.sh`: added `-lpthread` to gcc compile command

**Session 5 (2026-03-23)** — Runtime Verification & Bug Fixes:
- **Critical fix**: `wait_for_daemon_ready()` deadline nanosecond overflow — `timeout_ms * 1000000` for 15000ms = 15e9 exceeds `tv_nsec` range; only subtracted 1e9 once → timeout triggered in ~2s instead of 15s → gateway killed its own child with SIGTERM. Fix: split into `tv_sec += ms/1000` + `tv_nsec += (ms%1000)*1e6`
- Added `setsid()` after fork in child process — isolates child from parent's process group signals (defense-in-depth, not root cause)
- Added env forwarding from gateway to child: `OPENCODE_FRONTEND_PATH`, `OPENCODE_REPO_ROOT`, `OPENCODE_ALLOW_GLOBAL_FS_BROWSE`, `OPENCODE_WEB_NO_OPEN`
- Added unauthenticated health endpoint: `GET /api/v2/global/health` returns `{"healthy":true,"gateway":true}` without JWT
- Added comprehensive debug logging: SIGCHLD exit status/signal, JWT verify path, daemon state transitions, child exec args
- Renamed branding: "OpenCode Gateway" → "TheSmartAI" (header comment, startup log, login page title, fallback HTML)
- **Runtime verification PASSED**: JWT cookie auth → `find_or_create_daemon` → `ensure_daemon_running` → fork+setuid+exec → `opencode serve --unix-socket` → daemon ready → splice proxy → HTTP 200 with correct response
- **End-to-end verified**: Frontend HTML (1631B), JS assets (865B), API (`/global/auth/session` → `{"enabled":false,"authenticated":true}`) all served correctly through gateway → splice → daemon

**Issues Found**:
- `Bun.serve()` TypeScript overload mismatch for Unix socket mode → resolved with double-cast
- C compile error: `DaemonInfo` vs `Connection` struct member access → fixed
- `sdkSet` scope issue in provider.ts → fixed by adding to state return object
- Pre-existing TS errors in cron/*.ts, routes/session.ts, workflow-runner.ts — not introduced by our changes
- Session 3 hardening 仍缺 runtime evidence：single-user authenticated forwarding、SSE/WebSocket forwarding、multi-user isolation 需在適當 Linux runtime 環境補驗
- Session 4: `strncpy` truncation warnings in `submit_auth_job` → replaced with `snprintf`
- Session 4: `-Wformat-truncation` with 256-byte rtdir + suffix → reduced rtdir/candidate to 128 bytes
- Session 5: `wait_for_daemon_ready` nsec overflow → child killed by gateway after ~2s → fixed with proper sec/nsec split
- Session 5: Child missing `OPENCODE_FRONTEND_PATH` → daemon returned 404 for static files → fixed with env forwarding

### Root Cause
_(N/A - new feature)_

### Validation

**Static Analysis**:
- `tsc --noEmit`: No new errors introduced (pre-existing errors confirmed in unrelated modules)
- `bash -n webctl.sh`: Syntax valid
- `gcc -O2 -Wall -D_GNU_SOURCE -o daemon/opencode-gateway daemon/opencode-gateway.c -lpam -lpam_misc -lcrypto`: C gateway compiles successfully after Session 3 hardening
- `gcc -O2 -Wall -Werror -D_GNU_SOURCE -o gateway opencode-gateway.c -lpam -lpam_misc -lcrypto -lpthread`: Session 4 compile with `-Werror` + `-lpthread` PASSED
- Static contract review: current gateway code no longer contains `g_daemons[0]` demo routing, JWT TODO marker, or discovery fallback `/tmp/opencode-<uid>/daemon.json`
- Session 4 V2 static review: 7 invariants verified (no blocking in epoll loop, EPOLL_CTL_DEL before close, no sh -c in child, JWT claim validation complete, connection lifecycle correct, rate limiting correct, thread safety correct)

**Runtime Verification**:
- PASSED: single-user JWT auth → daemon spawn → splice proxy → frontend HTML/JS/API all served correctly (Session 5)
- Deferred: PAM login via browser (requires Linux password input)
- Deferred: SSE forwarding through splice proxy
- Deferred: WebSocket upgrade/streaming through splice proxy
- Deferred: multi-user isolation (alice/bob)
- β.6-7: Unix socket serve + discovery file lifecycle
- γ.8-11: TUI attach flow, multi-client sync, disconnect independence
- ε.7c/9/10: Account mutation concurrency, cross-client event propagation
- ζ.9-10: SSE reconnect catch-up, buffer overflow → sync.required
- θ.7-8: Long-running daemon memory stability, concurrent SSE connections
- ω.1/11: systemd mode, full regression

## Remaining

- [x] Phase β 實作
- [x] Phase γ 實作
- [x] Phase ε 實作
- [x] Phase α 實作
- [x] Session 3 gateway hardening（JWT claims / verified routing / lifecycle cleanup）
- [x] Session 4 structural hardening（non-blocking event loop / EpollCtx / PendingRequest / thread-per-auth / rate limiting / JWT persistence / WSL2 runtime path / PAM probe）
- [x] Phase δ 實作
- [x] Phase ζ/η/θ 實作
- [x] Phase ω 實作
- [x] Runtime verification — single-user JWT → daemon spawn → splice proxy → frontend+API (Session 5)
- [x] Runtime verification — PAM browser login through reverse proxy (Session 6)
- [x] Reverse proxy compatibility — cookie, auth routing, systemd integration (Session 6)
- [x] Client-side hardening — --attach fail-fast, XDG memory path, flush exclusion (Session 7)
- [x] Spec formalized to `specs/daemonization/` (Session 7)
- [ ] Runtime verification — SSE / WebSocket / multi-user (deferred)
- [ ] Webapp-side changes (ζ.6-8 Last-Event-ID reconnection, ε.8 account event subscription)

**Session 6 (2026-03-23~24)** — Reverse Proxy & systemd Integration:
- Case-insensitive cookie header parsing: nginx HTTP/2→HTTP/1.1 lowercases headers (`Cookie:` → `cookie:`). Fixed by searching both forms.
- Auth route priority: POST `/auth/login` handled before JWT verification to prevent proxying to daemon (which returns 404).
- JS client-side cookie: `document.cookie` + `window.location.replace('/')` instead of `Set-Cookie` header, bypassing nginx response header stripping.
- systemd service file: `opencode-gateway.service` with `EnvironmentFile=/etc/opencode/opencode.cfg`.
- Config template: added section 5 (OPENCODE_BIN, GATEWAY_PORT, LOGIN_HTML).
- webctl.sh: `switch_gateway_mode()`, unified `do_restart()` with auto-rebuild, `do_status()` with gateway mode + per-user daemon list (USER/PID/ALIVE/MODE/SOCKET).
- Branding: login page "TheSmartAI".
- End-to-end verified: crm.sob.com.tw → nginx → gateway → PAM auth → JWT → daemon → frontend.

**Session 7 (2026-03-24)** — Client-Side Hardening & Spec Formalization:
- `--attach` fail-fast: removed `Daemon.spawn()` auto-fallback; TUI now errors if no gateway-spawned daemon found.
- Memory MCP XDG path: changed from `<worktree>/.opencode/memory/` to `~/.local/share/opencode/memory/<project-id>/`. Root cause: gateway daemon cwd = home → worktree = home → mkdir creates `~/.opencode/`.
- webctl flush daemon exclusion: `list_stale_interactive_candidates()` now scans daemon.json discovery files and excludes known per-user daemon PIDs (gateway fork+setsid detaches child from process tree).
- `do_status()` refactored: removed obsolete `[Development (webctl PID)]` section, unified to gateway-centric layout.
- Spec formalized from `plans/20260323_c-root-daemon-splice-proxy/` to `specs/daemonization/`.

## Architecture Sync

Architecture Sync: Updated — added Daemon Architecture section (gateway, per-user daemon, TUI attach, SSE catch-up, security migration, performance hardening, deployment) to `specs/architecture.md`.

Architecture Sync (Session 4): Updated — `specs/architecture.md` C Root Gateway section now reflects non-blocking event loop, EpollCtx tagged dispatch, PendingRequest HTTP accumulation, thread-per-auth PAM, rate limiting, JWT file-backed persistence, execvp argv, splice directional proxy, connection lifecycle, runtime path detection (WSL2-safe), and PAM availability probe.

Architecture Sync (Session 5): Verified (No doc changes) — runtime bug fixes (deadline overflow, env forwarding) and branding rename do not change architectural boundaries or flows.

Architecture Sync (Session 6-7): Verified (No doc changes needed to architecture.md) — reverse proxy compat, systemd integration, --attach contract, XDG memory path, and flush exclusion are operational refinements within existing architectural boundaries. Spec formalized to `specs/daemonization/`.
