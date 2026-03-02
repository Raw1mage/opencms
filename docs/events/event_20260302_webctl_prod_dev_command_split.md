# Event: webctl production/dev command split

Date: 2026-03-02
Status: Done

## 需求

- 在 `webctl.sh` 中明確區分 development 與 production 控制指令。
- 新增 production 服務控制入口（`web-start` / `web-stop` / `web-restart`），避免與 dev 流程混用。

## 範圍

### IN

- 更新 `webctl.sh` 指令清單與 help 文案。
- 新增 `web-start` / `web-stop` / `web-restart`，透過 `systemctl` 控制 systemd 服務。
- 新增 `OPENCODE_SYSTEM_SERVICE_NAME` 以支援自定服務名稱（預設 `opencode-web`）。

### OUT

- 不調整既有 dev 行為（`dev-start` / `dev-stop` / `restart`）。
- 不改動 install script 與 systemd unit 內容。

## 任務清單

- [x] 新增 production 指令：`web-start` / `web-stop` / `web-restart`
- [x] 新增 `run_systemctl` helper（root/sudo 兼容）
- [x] 更新 help 文案與範例流程
- [x] 保留 dev 指令流程不變
- [x] `status` 同時顯示 dev PID 與 systemd production 狀態

## Debug Checkpoints

### Baseline

- `webctl.sh` 僅提供 dev 控制指令，缺少 production 服務操作入口。
- 使用者需手動輸入 `systemctl` 指令，與腳本流程割裂。

### Execution

- 在腳本內新增 `SYSTEM_SERVICE_NAME` 變數（可由 `OPENCODE_SYSTEM_SERVICE_NAME` 覆蓋）。
- 實作 `do_web_start` / `do_web_stop` / `do_web_restart` 並走 `run_systemctl`。
- 更新 command dispatch 與 help 顯示，將 production 指令獨立列出。
- 擴充 `do_status`：分段顯示 `[Development]`、`[Production]` 與統一 `[HTTP Health]`。

### Validation

- 靜態檢查：`webctl.sh` 已包含 `web-start` / `web-stop` / `web-restart` 分支與 help 文字。
- 行為設計：dev 與 production 控制面分離，不再語意混淆。
- 指令驗證：`./webctl.sh status` 可同時看到 dev 停止與 production 運行狀態。
