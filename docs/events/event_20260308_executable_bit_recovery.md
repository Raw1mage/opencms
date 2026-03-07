# Event: Executable Bit Recovery

Date: 2026-03-08
Status: Done

## 1. 需求

- 修復因錯誤 chmod 策略造成的 executable bit 流失。
- 以 git tracked mode 為單一真相來源，只恢復原本應為可執行的檔案。
- 驗證 install / web runtime 可正常啟動。

## 2. 範圍

### IN

- `/home/pkcs12/projects/opencode` tracked executable files
- `/home/pkcs12/projects/opencode/refs/claude-code` tracked executable files
- install / dev-start 驗證

### OUT

- 非 tracked 檔案的權限重寫
- templates/skills 內容變更
- 其他業務邏輯修復

## 3. 任務清單

- [x] 盤點 main repo / submodule 原本應為 100755 的檔案
- [x] 建立 event 與 debug checkpoints
- [x] 依 git tracked mode 恢復 executable bit
- [x] 驗證 install / web runtime health
- [x] 記錄 validation 與 architecture sync 結果

## 4. Debug Checkpoints

### Baseline

- 症狀：大量原本應可執行的腳本 / binary 被改為 644/664，導致 `install.sh`、`vite build`、`esbuild spawn` 失敗。
- 重現：`bash ./install.sh --yes` 曾因 `@esbuild/linux-x64/bin/esbuild EACCES` 失敗。
- 影響範圍：repo tracked executable files 與 `refs/claude-code` submodule tracked executable files。

### Execution

- 以 `git ls-files --stage` 篩出 `100755` 檔案清單，避免猜測式 chmod。
- 只對 tracked executable files 恢復 `+x`，不觸碰非 tracked 檔案與內容差異。
- main repo 以 `git ls-files --stage | awk '$1 == "100755" {print $4}' | while ... chmod +x` 恢復。
- `refs/claude-code` 以相同方法依 submodule 自身 git mode 恢復。

### Validation

- `bash ./install.sh --yes` ✅
  - 先前 `@esbuild/linux-x64/bin/esbuild EACCES` 失敗，補回 `+x` 後安裝完成。
- `./webctl.sh dev-start` ✅
- `./webctl.sh status` ✅ `{"healthy":true,"version":"local"}`
- `curl -s http://localhost:1080/api/v2/global/health` ✅ `{"healthy":true,"version":"local"}`
- `git diff --summary` 檢查後，main repo 剩餘 mode diff 僅在 `templates/skills/**` 計畫內變更。
- `git -C refs/claude-code diff --summary` ✅ 無剩餘 submodule mode diff。
- Architecture Sync: Verified (No doc changes)
  - 依據：本次僅修復 tracked executable bit 與啟動驗證，未改動 runtime / session / web architecture 結構。
