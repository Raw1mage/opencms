# Event: webctl Unified Stop/Restart

Date: 2026-03-08
Status: Done

## 1. 需求

- `webctl.sh stop` 提供 dev / production 兼用停止入口。
- `webctl.sh restart` 提供 dev / production 兼用重啟入口。
- 保留既有 `dev-stop` / `web-stop` / `web-restart` 細分命令。

## 2. 範圍

### IN

- `/home/pkcs12/projects/opencode/webctl.sh`
- `webctl.sh help` / command routing / stop-restart 行為

### OUT

- Web runtime 業務邏輯
- systemd unit 本身
- frontend code

## 3. 任務清單

- [x] 檢查現有 `webctl.sh` stop/restart routing 與 helper 結構
- [x] 建立 event 與 checkpoints
- [x] 實作 unified `stop` / `restart`
- [x] 驗證命令行為與 help 輸出
- [x] 記錄 validation 與 architecture sync

## 4. Debug Checkpoints

### Baseline

- 現況：`dev-stop` 與 `web-stop` 分離；`restart` 僅處理 dev restart。
- 風險：使用者必須記住不同模式命令，且 `restart` 語義與 `stop` 不一致。

### Execution

- 新增 mode detection helpers。
- `stop`：同時兼容 dev / production，若兩者都在跑則兩者都停。
- `restart`：優先重啟目前活躍模式；若兩者都活躍則兩者都重啟；若都未活躍則維持既有 dev restart fallback。
- 補上 `do_dev_stop` 清除 `PID_FILE`，避免 `stop` 後 `status` 殘留 stale running 顯示。
- 補上 `do_status` 讀 PID 檔容錯，避免 stop/restart race 期間出現 `cat: ... No such file`。

### Validation

- `bash -n /home/pkcs12/projects/opencode/webctl.sh` ✅
- `./webctl.sh help` ✅ 已顯示 `stop` / `restart` 新語義
- `./webctl.sh stop` ✅ 成功停止 dev server
- `./webctl.sh dev-start` ✅ 可重新啟動 dev server
- `./webctl.sh restart --graceful` ✅ detached worker 正常排程並完成
- `./webctl.sh status` ✅ 最終顯示 `{"healthy":true,"version":"local"}`
- Architecture Sync: Verified (No doc changes)
  - 依據：本次僅調整 `webctl.sh` 命令路由與 operational helper，未改動系統架構與模組邊界。
