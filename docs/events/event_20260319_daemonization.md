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

**Issues Found**:
- `Bun.serve()` TypeScript overload mismatch for Unix socket mode → resolved with double-cast
- C compile error: `DaemonInfo` vs `Connection` struct member access → fixed
- `sdkSet` scope issue in provider.ts → fixed by adding to state return object
- Pre-existing TS errors in cron/*.ts, routes/session.ts, workflow-runner.ts — not introduced by our changes

### Root Cause
_(N/A - new feature)_

### Validation

**Static Analysis**:
- `tsc --noEmit`: No new errors introduced (pre-existing errors confirmed in unrelated modules)
- `bash -n webctl.sh`: Syntax valid
- `gcc -O2 -Wall`: C gateway compiles with no warnings (with `-D_GNU_SOURCE`)

**Runtime Verification** (deferred — requires multi-user Linux environment):
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
- [x] Phase δ 實作
- [x] Phase ζ/η/θ 實作
- [x] Phase ω 實作
- [x] Architecture sync
- [ ] Runtime verification (requires deployment environment)
- [ ] Webapp-side changes (ζ.6-8 Last-Event-ID reconnection, ε.8 account event subscription)

## Architecture Sync

Architecture Sync: Updated — added Daemon Architecture section (gateway, per-user daemon, TUI attach, SSE catch-up, security migration, performance hardening, deployment) to `specs/architecture.md`.
