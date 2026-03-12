# Event: webctl restart stop flush start

Date: 2026-03-12
Status: Done

## 1) 需求

- 使用者要求：將 `webctl.sh restart` 的 dev restart path 重構為 `stop → flush → start`。
- 目的：降低舊 bun child process / orphan process tree 在 restart 後殘留的風險。

## 2) 範圍 (IN/OUT)

### IN

- `/home/pkcs12/projects/opencode/webctl.sh`
- `/home/pkcs12/projects/opencode/README.md`
- `/home/pkcs12/projects/opencode/docs/ARCHITECTURE.md`
- 本 event

### OUT

- 不重寫 backend child lifecycle 管理
- 不新增模糊型 cleanup fallback（如 `pkill bun`）
- 不主動執行 live restart

## 3) 任務清單

- [x] 重新檢查現有 flush/orphan helper 能力
- [x] 將 dev restart worker 串成 stop → flush → start
- [x] 將 restart ledger 增加 flush stage
- [x] 更新 README / ARCHITECTURE / event 說明
- [x] 執行靜態驗證

## 4) Debug Checkpoints

### Baseline

- `webctl.sh` 已有 `flush` 命令與 orphan candidate 偵測/清理 helper。
- 但 `do_restart_worker()` 原本只有 `stop -> start`，沒有在 restart 流程中自動執行 flush。

### Instrumentation Plan

- 只改 `do_restart_worker()` 的 dev restart 路徑。
- 保留現有 detached worker / graceful preflight / restart lock 契約。
- 以 restart JSONL ledger 增加 `flush` stage 做可觀測化。

### Execution

- 在 `do_restart_worker()` 中加入：
  - `flush started`
  - `do_flush`
  - `flush ok|failed`
- 文件同步改為明示 dev restart pipeline 為 `stop -> flush -> start`。

### Root Cause

- 既有 `flush` 能力存在，但沒有被 restart path 採用，導致 restart 無法自動清理 stop 後殘留的 orphan candidate。

### Validation

- ✅ `bash -n /home/pkcs12/projects/opencode/webctl.sh`
- ✅ `bash /home/pkcs12/projects/opencode/webctl.sh help`
- Architecture Sync: Updated
  - 已更新 `docs/ARCHITECTURE.md` 說明 webctl restart 的 dev pipeline
- 未執行 live restart
  - 原因：避免未經使用者要求中斷當前 web runtime
