# Tasks: Daemonization V2

## Phase 1: Discovery Enhancement（Additive, 無破壞性）

- [x] 1.1 新增 `Daemon.isSocketConnectable(socketPath)` — fetch health endpoint over Unix socket with 2s timeout
- [x] 1.2 新增 `Daemon.spawnOrAdopt(opts)` — adopt-first + spawn-fallback 統一入口
- [~] 1.3 `readDiscovery()` 增加 socket connectivity probe — 改由 spawnOrAdopt() 層處理，readDiscovery() 保持輕量（PID check only）
- [x] 1.4 `spawn()` 保留 bun flags（`--conditions=browser` 等）— 修正 spawnArgs 建構邏輯
- [x] 1.5 `daemon.json` schema 擴充：加入 `spawnedBy` 欄位
- [ ] 1.6 驗證：手動測試 spawnOrAdopt（先 spawn 再 adopt、先 adopt 已存在的 daemon）

## Phase 2: TUI Always-Attach（核心改動）

- [x] 2.1 `thread.ts` handler：非-attach 路徑改為呼叫 `Daemon.spawnOrAdopt()` + Unix socket attach
- [x] 2.2 `thread.ts`：directory 從 `process.cwd()` / `args.project` 解析後，傳入 `tui({ directory })` → SDK `x-opencode-directory` header
- [~] 2.3 `tui()` function signature — 已支援 `directory` 參數，無需改動
- [x] 2.4 `--attach` flag 保留但標記 deprecated（行為與預設相同）
- [x] 2.5 移除 Worker thread 建立邏輯（`new Worker(workerPath, ...)` 區塊）
- [x] 2.6 移除 `createWorkerFetch()` 和 RPC-based `createEventSource()`
- [x] 2.7 移除 Worker RPC 相關程式碼（`client.call("server")`, `client.call("shutdown")`, `client.call("reload")`）
- [x] 2.8 調整 TUI exit handler：不再 `worker.terminate()`，改為只 abort SSE + 不 kill daemon
- [x] 2.9 Debug attach empty-state：root cause = `local.tsx` 呼叫 in-process `Account.listAll()` 而非 SDK HTTP；fix = 改為 `sdk.client.account.listAll()`
- [ ] 2.10 驗證：`bun run dev` 啟動後 daemon.json 存在、TUI 正常顯示 accounts/sessions
- [ ] 2.11 (discovered) `dialog-admin.tsx` / `dialog-account.tsx` 仍有大量 in-process Account calls，attach mode 會壞 — 需後續遷移

## Phase 3: Worker Mode Cleanup

- [x] 3.1 移除 `packages/opencode/src/cli/cmd/tui/worker.ts`
- [~] 3.2 `OPENCODE_CLI_TOKEN` 保留 — killswitch.ts 仍需要透過 HTTP CLI token auth
- [~] 3.3 `OPENCODE_CLI_TOKEN` 審查完成 — app.ts (server auth), killswitch.ts (CLI auth) 仍有用途
- [x] 3.4 審查 `Rpc` namespace 在 TUI context 的引用 — 已無殘留
- [x] 3.5 移除 `OPENCODE_WORKER_PATH` 全域宣告和 build.ts entrypoint
- [ ] 3.6 驗證：`tsc --noEmit` 無新錯誤（tsc OOM，待環境驗證）

## Phase 4: Gateway Adopt Hardening

- [ ] 4.1 確認 `try_adopt_from_discovery()` 在 gateway 中包含 socket connectivity probe（不只是 PID alive）
- [ ] 4.2 新增 lazy liveness check：splice 失敗時 check daemon alive → cleanup if dead → re-spawn on next request
- [ ] 4.3 處理 adopted daemon crash：gateway registry entry 清理（non-child PID 不觸發 SIGCHLD）
- [ ] 4.4 驗證：TUI 先 spawn daemon → gateway login → adopt 成功 → web 可正常使用

## Phase 5: systemd / webctl.sh 整合

- [ ] 5.1 決策：systemd per-user service 保留（改為 Unix socket mode）或移除
- [ ] 5.2 若保留：修改 `opencode-user-daemon-launch` 為 `opencode serve --unix-socket`
- [ ] 5.3 若移除：刪除 `opencode-user-daemon@.service` 及相關設定
- [ ] 5.4 `webctl.sh do_status()`：統一列出所有 per-user daemon（不分 Worker/HTTP/Unix 類型）
- [ ] 5.5 `webctl.sh do_stop()`：統一信號所有 daemon（讀取各 user 的 daemon.json）
- [ ] 5.6 移除 `OPENCODE_PER_USER_DAEMON_EXPERIMENTAL` 及相關 route flags（`UserDaemonManager` 不再需要）
- [ ] 5.7 驗證：`webctl.sh status` 和 `webctl.sh stop` 正確管理所有 daemon

## Phase 6: Integration Validation

- [ ] 6.1 場景：TUI 啟動 → web login → 兩端都能看到相同 accounts/sessions
- [ ] 6.2 場景：Web login 先啟動 daemon → TUI 啟動 → adopt → 兩端同步
- [ ] 6.3 場景：daemon crash → TUI 重新啟動 → auto-spawn new daemon
- [ ] 6.4 場景：daemon crash → web 重新連接 → gateway re-spawn
- [ ] 6.5 場景：`webctl.sh stop` + `webctl.sh dev-start` → web 和 TUI 都正常
- [ ] 6.6 場景：同時啟動 TUI 和 web login → 只有一個 daemon（race safety）
- [ ] 6.7 `tsc --noEmit` 無新增錯誤
- [ ] 6.8 更新 `specs/architecture.md` Daemon Architecture 章節
- [ ] 6.9 建立 `docs/events/event_<date>_daemonization-v2.md`

## Dependencies

```
Phase 1 → Phase 2 → Phase 3
Phase 1 → Phase 4
Phase 2 + Phase 4 → Phase 5
Phase 3 + Phase 5 → Phase 6
```

## Approval Gates

- [x] **Phase 2 開始前**：確認 always-attach 策略（消除 Worker mode）
- [ ] **Phase 5.1**：決策 systemd per-user service 的處置方式
- [ ] **Phase 6.8**：architecture.md 更新內容審查
