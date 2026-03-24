# Proposal: Daemonization V2 — Unified Per-User Process Model

**Date**: 2026-03-24
**Author**: pkcs12
**Status**: Draft
**Predecessor**: `specs/daemonization/` (V1 — gateway + daemon + attach)

## Problem Statement

Daemonization V1 成功建立了三種 runtime process 類型：

1. **Worker thread mode** — TUI 啟動 in-process Bun Worker，透過 RPC 與 TUI 通訊。Worker 內建完整 server，但沒有 discovery、沒有 socket、外部不可見。
2. **Unix socket daemon** — 由 gateway `fork+setuid+exec` 或 TUI `Daemon.spawn()` 產生，寫入 `daemon.json` 供 discovery。TUI `--attach` 可連接。
3. **HTTP daemon (systemd)** — `opencode-user-daemon@.service` 在 port 42000 上運行，獨立於 gateway，有自己的 env 和路由旗標（`OPENCODE_PER_USER_DAEMON_EXPERIMENTAL`）。

### 核心問題：三者互不知曉

| 情境 | 問題 |
|-------|------|
| TUI Worker mode 啟動後，gateway login 找不到該 process | gateway 不讀 Worker，Worker 不寫 daemon.json |
| gateway spawn daemon 後，TUI `bun run dev` 啟動另一個 Worker | 兩個獨立 process 各有自己的 state，accounts/sessions 不同步 |
| systemd HTTP daemon 與 gateway daemon 並存 | 兩個 listening process 共用同一 accounts.json，race condition |
| `webctl.sh stop` + `dev-start` 後，web 和 TUI 同時壞掉 | 多重 process 的生命週期沒有統一管理 |

### 使用者觀察到的症狀

- `bun run dev` (Worker mode) 可正常運作
- `bun run dev --attach` 連接到 daemon 後，accounts/sessions list 為空（attach mode 無法正確載入 state）
- Web login 被踢回首頁（JWT cookie 失效 / gateway 重啟後 key 重生）
- `webctl.sh stop` 無法清理所有 process 類型

## Target Architecture

**每個 user 恰好一個 opencode process**，不論從哪裡啟動、從哪裡存取。

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────────────┐
│ TUI Client  │────→│                  │←────│  C Gateway (:1080)  │
│ (attach)    │unix │  Per-User Daemon │splice│  (PAM + JWT)        │
│             │sock │  (the ONE process)│     │                     │
└─────────────┘     │                  │     └─────────────────────┘
                    │  - Unix socket   │
                    │  - daemon.json   │
                    │  - Full server   │
                    │  - All state     │
                    └──────────────────┘
```

### 核心原則

1. **Single process per user** — 不論 TUI 或 gateway 先觸發，最終只有一個 opencode process
2. **Discovery-first coordination** — `daemon.json` 是唯一的 process 註冊中心
3. **Spawn-or-adopt** — 後到者發現已有 process 就 adopt，不再 spawn
4. **TUI always-attach** — 消除 Worker mode，TUI 一律以 thin client attach 到 daemon
5. **Gateway adopt-first** — gateway login 時先檢查 daemon.json，有就 splice proxy，沒有才 fork+exec

## Scope

### IN

- 消除 Worker thread mode（thread.ts 的 Worker 路徑）
- TUI 預設行為改為 always-attach（spawn-if-needed + attach）
- Gateway adopt-first protocol（已部分實作於 `try_adopt_from_discovery()`）
- 統一 daemon 生命週期管理（startup, discovery, shutdown, cleanup）
- 消除 systemd HTTP daemon 作為獨立 process type
- `webctl.sh` 統一 process 管理命令

### OUT

- C gateway 本身的重寫（保持現有 epoll + splice 架構）
- 跨機器 TUI attach
- Webapp 前端 UI 變更（除了必要的 SDK client 調整）
- PTY session 孤兒回收（獨立議題）
- 多 workspace 同時運行（一個 daemon 服務多個 project directory）

## Success Criteria

1. `bun run dev` 與 `bun run dev --attach` 行為一致：都 attach 到 daemon
2. Gateway login 後可 adopt TUI 先前 spawn 的 daemon
3. TUI 啟動時可 adopt gateway 先前 spawn 的 daemon
4. 同一 user 不會同時存在兩個 opencode process
5. `webctl.sh stop` 能清理所有 per-user daemon
6. Accounts/sessions 在 web 和 TUI 之間完全同步（因為是同一個 process）

## Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| Worker mode 移除影響開發體驗 | Medium | 確保 auto-spawn 夠快（< 3s），TUI 啟動不需等待 gateway |
| daemon.json race condition（TUI 和 gateway 同時 spawn） | Low | daemon.pid 已有 single-instance guard |
| Bun Worker thread 的 RPC 功能喪失 | Low | attach mode 已有 Unix socket fetch + SSE，功能等價 |
| `--conditions=browser` 遺失 | Medium | daemon spawn 需保留 bun flags |
