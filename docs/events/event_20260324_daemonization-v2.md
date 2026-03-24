# Event: Daemonization V2 — Unified Per-User Process Model

**Date**: 2026-03-24
**Branch**: `daemonization-v2` (base: `cms`)
**Plan**: `plans/20260324_daemonization-v2/`

## 需求

消除三種互不知曉的 runtime process type（Worker thread, Unix socket daemon, HTTP daemon），統一為「每 user 恰好一個 opencode daemon process」。TUI 從 in-process Worker mode 改為 always-attach thin client。

## 範圍

### IN
- Phase 1: Discovery Enhancement（spawnOrAdopt, socket probe, bun flags preservation）
- Phase 2: TUI Always-Attach（消除 Worker mode）
- Phase 3: Worker Mode Cleanup（移除 worker.ts, build entrypoint）
- Attach empty-state bug fix（local.tsx Account.listAll in-process → SDK HTTP）

### OUT
- Gateway C code 改動（Phase 4）
- systemd / webctl.sh 整合（Phase 5）
- dialog-admin / dialog-account in-process Account calls 遷移
- 完整 integration validation（Phase 6）

## 任務清單

見 `plans/20260324_daemonization-v2/tasks.md`

## Key Decisions

- **spawnOrAdopt 在 Daemon module 層**：不放在 thread.ts，而是 daemon.ts 提供統一入口
- **socket connectivity probe 放在 spawnOrAdopt 層**：readDiscovery() 保持輕量（PID check only），spawnOrAdopt() 才做 health fetch
- **OPENCODE_CLI_TOKEN 保留**：killswitch.ts 仍需要 CLI→server HTTP auth，不隨 Worker 一起移除
- **directory 由 TUI 傳入**：V1 attach mode 沒傳 directory 是 bug，V2 修正為 always 傳
- **bun flags 保留**：spawn() 新增 `--conditions=` / `--preload=` 旗標傳遞

## Debug Checkpoints

### Baseline
- 症狀：`bun run dev --attach` 連接 daemon 後 accounts/sessions list 為空
- 重現：啟動 daemon → TUI attach → TUI 顯示空白
- 影響範圍：`local.tsx`, `sync.tsx`, `thread.ts`, `daemon.ts`

### Instrumentation Plan
- 追蹤 SDK client creation → directory propagation → server middleware
- 追蹤 bootstrap() → session.list / account.list → response

### Execution
- 完整追蹤 8 層資料流（thread → app → sdk → SDK client → server middleware → Instance.provide → session route → Session.listGlobal）
- 發現 `local.tsx` line 25 呼叫 `Account.listAll()` 是 **in-process call**，不走 HTTP

### Root Cause
- `local.tsx` import `@/account` 並呼叫 `Account.listAll()` → 直接讀 accounts.json
- Worker mode 中 TUI process 內有完整 server runtime，Account module 可正常運作
- Attach mode 中 TUI process 只是 thin client，沒有 Account storage layer → 回傳空結果
- Causal chain: TUI attach → local.tsx init → Account.listAll() → no storage → empty {} → UI 顯示空白

### Secondary Finding
- V1 `--attach` mode 沒有傳 `directory` 給 `tui()` → server 用 `defaultDirectory`（user home）
- sessions 篩選結果可能也是空的（sessions 在 `/home/pkcs12/projects/opencode` 不是 `/home/pkcs12`）

## Validation

### Static
- `local.tsx` Account.listAll() 改為 `sdk.client.account.listAll()` — SDK HTTP API
- `thread.ts` 現在 always 傳 `directory` 給 `tui()`
- `daemon.ts` 新增 `spawnOrAdopt()` + `isSocketConnectable()`
- `worker.ts` 已移除
- `build.ts` 已移除 worker entrypoint 和 OPENCODE_WORKER_PATH
- tsc: OOM（環境限制，非新引入問題）

### Runtime
- [ ] `bun run dev` 啟動 → daemon.json 存在 → TUI 顯示 accounts/sessions
- [ ] `bun run dev` 再開一個 TUI → adopt 同一 daemon
- [ ] TUI 退出後 daemon 持續運行

### Known Remaining Issues
- `dialog-admin.tsx` / `dialog-account.tsx` 仍有 in-process Account calls（需後續遷移）
- Gateway Phase 4 hardening（lazy liveness check for adopted daemons）待實作
- systemd / webctl.sh Phase 5 整合待實作

## Architecture Sync

待 Phase 6 完成後全面同步 `specs/architecture.md`。本 session 已建立基礎設施（spawnOrAdopt, always-attach, Worker elimination），但尚未完成 integration validation。
