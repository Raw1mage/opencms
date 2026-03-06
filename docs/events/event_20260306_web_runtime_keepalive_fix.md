# Event: Web Runtime Keepalive Fix

## 需求

- 修復 `./webctl.sh dev-start` / `dev-refresh` 後 web backend 立即退出，導致 webapp 出現 `502` 與無法登入。

## 範圍

IN:
- `packages/opencode/src/cli/cmd/web.ts`
- `packages/opencode/src/cli/cmd/serve.ts`
- `docs/events/event_20260306_web_runtime_keepalive_fix.md`

OUT:
- 不修改 reverse proxy 設定
- 不修改 PAM / htpasswd 驗證流程
- 不修改 frontend bundle

## 任務清單

- [x] 確認 `webctl.sh` 是唯一啟動入口
- [x] 追查 backend 啟動後立即退出的原因
- [x] 修正 web/serve command 的 keepalive 行為
- [x] 修正 `webctl.sh` 背景啟動與 PID 對齊
- [x] 驗證 web runtime 恢復健康
- [x] 更新 event 驗證與 Architecture sync

## Debug Checkpoints

### Baseline

- 使用者回報 webapp `login failed 502`
- `./webctl.sh status`
  - 顯示 `stopped` 或 `Health: (unreachable)`
- `curl http://127.0.0.1:1080/health`
  - 無法連線
- `curl -k https://crm.sob.com.tw/health`
  - 回 `HTTP/2 502`
- `packages/opencode/src/cli/cmd/web.ts`
  - 使用 `await new Promise(() => {})` 嘗試阻止程序退出
- `packages/opencode/src/cli/cmd/serve.ts`
  - 同樣使用 `await new Promise(() => {})`

### Execution

- 將 `web` / `serve` command 改為用具體 keepalive timer + signal cleanup 維持進程生命週期
- 保留原有 `Server.listen()` 與 `server.stop()` 邏輯
- 修正 `packages/opencode/src/index.ts` 以 `parseAsync()` 等待 async command handler，避免 `finally { process.exit() }` 提早收尾
- 修正 `webctl.sh`
  - `dev-start` 改用 `script` 分配 PTY 啟動背景 server，避免背景無 TTY 時 Bun 進程提早結束
  - health 成功後以 `ss` 回填實際 backend PID，避免 `status`/`dev-stop` 追到 wrapper PID
- 透過 `./webctl.sh dev-start` 驗證 backend 可持續存活

### Validation

- `./webctl.sh dev-stop`
  - 通過，可清除舊的占用 process
- `./webctl.sh dev-start`
  - 通過，server 正常啟動
- `./webctl.sh status`
  - 通過，顯示 `running` 且 `Health: {"healthy":true,"version":"local"}`
- `curl http://127.0.0.1:1080/health`
  - 通過，可連到本機 web runtime
- `curl -k https://crm.sob.com.tw/health`
  - 通過，外部 URL 回 `HTTP/2 200`
- `bun x tsc -p packages/opencode/tsconfig.json --noEmit`
  - 未取得可用完成結果；本次以 runtime 行為驗證為主
- Architecture Sync: Verified (No doc changes)
  - 依據：本次僅修正 CLI 啟動等待與 webctl 啟動方式，未改動系統架構、API schema 或 provider 邊界
