# Event: Workspace current-state documentation

Date: 2026-03-09
Status: Done

## 需求

- 在 `new-workspace` 合併進 `cms` 後，補一份可交接的現況總覽。
- 讓人類休息前，能用最少閱讀成本理解：已完成什麼、還缺什麼、下一步做什麼。

## 範圍

### IN

- `/home/pkcs12/projects/opencode/docs/specs/workspace-current-state.md`
- `/home/pkcs12/projects/opencode/docs/specs/workspace-phase-completion-checklist.md`

### OUT

- 不新增 runtime/app 功能
- 不再擴充 preview domain

## 任務清單

- [x] 新增 workspace 現況總覽文件
- [x] 更新 phase checklist 為合併後狀態
- [x] 記錄當前 deferred / next steps

## Debug Checkpoints

### Baseline

- workspace rewrite 已完成合併進主 repo `cms`。
- 目前文件雖完整，但分散於多份 spec / event，缺少一份合併後的單頁總覽。

### Execution

- 新增 `docs/specs/workspace-current-state.md`，整理：
  - 已合併完成的 runtime/app 能力
  - 現在系統的單一事實來源
  - reset/delete runtime-owned operations
  - preview deferred 狀態
  - 建議後續開發方向
- 更新 `docs/specs/workspace-phase-completion-checklist.md`：
  - 將 Phase 3 調整為 `Complete for current milestone`
  - 明確標記目前已進入「新 workspace 系統時代」

### Validation

- 文件已落地，可作為人類休息前的交接材料 ✅
- Architecture Sync: Verified (No doc changes)
  - 本次任務是現況文檔收斂；`docs/ARCHITECTURE.md` 既有 workspace 條目已足夠描述架構現況，無需再改。
