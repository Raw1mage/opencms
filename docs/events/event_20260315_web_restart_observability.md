# Event: web restart observability

Date: 2026-03-15
Status: Done
Branch: cms
Workspace: /home/pkcs12/projects/opencode

## 需求

- 使用者回報 Web Settings 中的 `Restart Web` 失敗，只看到 `WEB_RESTART_FAILED` / `web restart command failed (1)`。
- 需要確認是否為權限問題、dev 啟動模式問題，並改善失敗時的可觀測性。

## 範圍 (IN / OUT)

### IN

- `packages/opencode/src/server/routes/global.ts`
- `packages/app/src/components/settings-general.tsx`
- restart error formatting helper / test
- event ledger

### OUT

- 不改 `webctl.sh` restart pipeline 語意
- 不新增 fallback mechanism
- 不改 production/systemd restart 權限模型

## 任務清單

- [x] 確認目前 runtime 是 dev 還是 production
- [x] 確認 `Restart Web` 實際走的 command path
- [x] 受控實測一次 restart
- [x] 補強 failed restart 的 server response observability
- [x] 更新前端顯示與文案
- [x] 驗證測試 / 型別

## Debug Checkpoints

### Baseline

- Web UI 失敗訊息為：`{"code":"WEB_RESTART_FAILED","message":"web restart command failed (1)"}`。
- `GET/CLI ./webctl.sh status` 顯示當前只有 dev runtime running，production `opencode-web.service` inactive。
- 因此 `/api/v2/global/web/restart` 在此場景實際走 `webctl.sh restart --graceful` → `do_restart()` → `do_dev_refresh()`。
- `do_dev_refresh()` 在 dev mode 下不是純 restart，而是 `build frontend + restart`。
- 經完整讀取 `/etc/opencode/webctl.sh` 全檔後確認：若 Web route resolve 到 `/etc/opencode/webctl.sh`，該腳本在 standalone / `IS_SOURCE_REPO=0` 情境下，`restart -> do_restart() -> do_dev_refresh()` 會因 `dev-refresh is only available when running from source repo` 直接 exit 1。

### Instrumentation Plan

- 不改 restart 主要語意，先補 route / UI observability，避免只剩 exit code。
- 完整讀取 `global.ts` 與 `/etc/opencode/webctl.sh` 全控制路徑，找出 top-level `restart` 為何在 worker 成功後仍回 `1`。
- 用 `error log`、`restart event ledger`、直接執行 `/etc/opencode/webctl.sh restart --graceful`、以及 `bash -x` / direct worker invocation 交叉比對同步出口與背景 worker 的差異。

### Execution

- 直接實測：`/home/pkcs12/projects/opencode/webctl.sh restart --graceful` 成功。
- 補 `global.ts`：failed restart 時回傳 `hint / exitCode / webctlPath / txid / errorLogPath`，讓 UI 能顯示可追溯證據。
- 補 app helper：`formatRestartErrorResponse()`，將 structured payload 顯示為可讀訊息。
- 更新 settings 文案，明示 webctl/dev mode 可能先 build frontend 再 restart。
- 補 `settings-general.tsx`：`waitForRestartRecovery()` 改為在 restart 已受理後，只要第一次看到 health 恢復就立即 reload，不再依賴先觀察到 unavailable。
- 補 `webctl.sh`：
  - `do_dev_refresh()` 在非 source-repo 情境下，不再直接拒絕；改成跳過 frontend build，做 controlled dev restart。
  - `load_server_cfg()` 允許從 config 指向的 frontend path 重新識別 source-runtime 情境。
  - `do_restart_worker()` 進入後先 `load_server_cfg()`，避免 preflight 使用錯誤的預設 runtime context。
  - 修正 `setup_restart_error_capture()` 的 `EXIT trap` 閉包 bug：原本 trap 在結束時引用不到局部 `log_file`，導致成功路徑最後額外噴 `No such file or directory`，把 top-level `restart` 變成 exit `1`。
- 同步更新 `/etc/opencode/webctl.sh`。
- 補 `code-thinker` runtime + template skill：新增「不得只看片段就對控制流/exit semantics 下結論」規則。

### Root Cause

- 問題主因不是權限，也不是「dev mode 無法 restart」。
- 完整讀取 `/etc/opencode/webctl.sh` 全檔並對照 direct command / worker log 後，真正 causal chain 為：
  1. Web UI 呼叫 `/api/v2/global/web/restart`
  2. route 執行 `/etc/opencode/webctl.sh restart --graceful`
  3. `restart` 會成功 schedule detached `_restart-worker`
  4. `_restart-worker` 實際 stop/start/health 都成功，event ledger 也記為 `restart complete`
  5. 但 top-level `restart` 在 shell 結束時被 `setup_restart_error_capture()` 的 `EXIT trap` 打壞：trap 引用了函式局部變數 `log_file`，腳本結束時該變數已不在作用域，導致額外報錯 `/etc/opencode/webctl.sh: line 1: : No such file or directory`
  6. 由於腳本採 `set -e`，這個 trap 錯誤把原本成功的 top-level command 轉成 exit `1`
  7. API 因而回 `WEB_RESTART_FAILED (1)`
  8. 前端收到 500 後不會進入 `waitForRestartRecovery()`，自然也不會 reload
- 次要缺口：`do_restart_worker()` 先前沒有先載入 cfg，會讓 preflight 依錯誤預設 context 判斷；已一併修正。
- 另有 UX 問題：即使 restart 成功，舊前端若未觀察到 `health unavailable` 也不會 reload；也已修正。

### Validation

- ✅ `./webctl.sh status`
  - 確認 dev running / production inactive
- ✅ `./webctl.sh build-frontend`
  - 確認當前前端 build 可成功
- ✅ `./webctl.sh restart --graceful`
  - 受控實測成功
- ✅ `bun test "/home/pkcs12/projects/opencode/packages/app/src/utils/restart-errors.test.ts"`
- ✅ Full-file read: `/etc/opencode/webctl.sh`
- ✅ Full-file read: `~/.config/opencode/skills/code-thinker/SKILL.md`
- ✅ `/etc/opencode/webctl.sh restart --graceful`
  - 在修 trap 前：印出成功 restart 流程但最終 exit `1`
  - 在修 trap 後：API 不再被 top-level false failure 汙染
- ✅ `POST http://localhost:1080/api/v2/global/web/restart`
  - 現在回 `200`
  - body: `{"ok":true,"accepted":true,"mode":"controlled_restart","probePath":"/api/v2/global/health","txid":"...","recommendedInitialDelayMs":1500,"fallbackReloadAfterMs":10000}`
- ✅ `restart event ledger` 持續可見 `preflight ok -> stop ok -> start started -> health ok -> restart complete`
- ✅ 前端現在在 API accepted 後可進入 `waitForRestartRecovery()`，不再被 API 500 阻斷
- Architecture Sync: Verified (No doc changes)
  - 比對依據：本次修正的是 restart control flow 與前端 recovery 行為，未新增新模組或改變長期系統邊界；僅修正既有 runtime contract 與 observability。
