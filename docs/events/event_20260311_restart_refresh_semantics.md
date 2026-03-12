# Event: restart refresh semantics

Date: 2026-03-11
Status: Done

## 1) 需求

- 使用者要求：`./webctl.sh restart` 不要只做純重啟。
- 目標：讓 `restart` 在不同模式下自動走會重新套用 repo 更新的 refresh 路徑。

## 2) 範圍 (IN/OUT)

### IN

- `/home/pkcs12/projects/opencode/webctl.sh`
- `/home/pkcs12/projects/opencode/README.md`
- `/home/pkcs12/projects/opencode/docs/ARCHITECTURE.md`
- 本 event 紀錄

### OUT

- 不變更 `install.sh` 的部署邏輯
- 不變更 web backend / frontend 業務邏輯
- 不主動執行 live restart / deploy

## 3) 任務清單

- [x] 確認新的 `restart` 目標語義
- [x] 調整 `webctl.sh restart` mode-aware refresh 路由
- [x] 避免 `dev-refresh` 與 `restart` 互相遞迴
- [x] 更新 help / README / architecture 說明
- [x] 執行靜態驗證並記錄未執行 live restart 的原因

## 4) Debug Checkpoints

### Baseline

- 現況：`restart` 在 dev 僅做 `do_dev_restart()`，在 production 僅做 `web-restart`。
- 問題：若 repo 有 frontend 或 deploy 內容更新，單純 restart 不會保證新內容被重新 build/deploy 到 web runtime。

### Instrumentation Plan

- 檢查 `webctl.sh` 的 `do_restart()` / `do_dev_refresh()` / `do_web_refresh()` 呼叫鏈。
- 確認新語義下不會形成 `restart -> dev-refresh -> restart` 遞迴。
- 補齊 help / README / architecture 文件，避免命令語義與實作漂移。

### Execution

- 將 `restart` 改為：
  - dev only → `dev-refresh`
  - prod only → `web-refresh`
  - dev + prod 同時存在 → 兩者都 refresh
  - 無 active mode → fallback 到 dev refresh
- 將 `do_dev_refresh()` 的重啟段改為直接呼叫 `do_dev_restart --graceful`，避免與新 `restart` 語義遞迴。

### Root Cause

- 舊設計把 `restart` 定位成 process lifecycle 操作，不是 code refresh/deploy 操作。
- 但本 repo 的 web frontend 依賴 `packages/app/dist` 與 production install/deploy 流程，純 restart 無法滿足「套用 repo 更新」這個使用者心智模型。

### Validation

- ✅ `bash -n /home/pkcs12/projects/opencode/webctl.sh`
- ✅ `bash /home/pkcs12/projects/opencode/webctl.sh help`
  - 已確認 help 顯示 `restart = dev=dev-refresh, prod=web-refresh`
- ✅ `README.md` 已同步更新操作建議，明示 `restart` 會自動走 mode-aware refresh
- Architecture Sync: Updated
  - 已同步更新 `docs/ARCHITECTURE.md` 的 `webctl.sh` 角色描述與 canonical refresh shortcut
- 未執行 live `restart/web-refresh`
  - 原因：避免在未經使用者要求下中斷當前 web runtime
