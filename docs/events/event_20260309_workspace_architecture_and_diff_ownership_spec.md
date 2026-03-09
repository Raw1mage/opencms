# Event: Workspace Architecture and Diff Ownership Spec

Date: 2026-03-09
Status: Done

## 需求

- 補強 `docs/ARCHITECTURE.md`，詳實記錄 workspace 抽象層設計、邊界與資料流規格。
- 釐清目前「檔案異動 / dirty bubble」應優先重用的 workspace/runtime 抽象，而不是繼續在 app 端重複實作 heuristic。
- 產出一份可執行的 runtime design note，定義 authoritative session-owned file diff attribution contract。

## 範圍 (IN / OUT)

### IN

- `/home/pkcs12/projects/opencode/docs/ARCHITECTURE.md`
- `/home/pkcs12/projects/opencode/docs/events/event_20260309_workspace_architecture_and_diff_ownership_spec.md`
- `/home/pkcs12/projects/opencode/docs/events/event_20260307_workspace_context_analysis.md`
- `/home/pkcs12/projects/opencode/docs/events/event_20260308_workspace_rewrite_spec.md`
- `/home/pkcs12/projects/opencode/docs/events/event_20260308_workspace_registry_runtime_integration.md`
- `/home/pkcs12/projects/opencode/docs/events/event_20260308_workspace_api_global_sync_consumption.md`
- `/home/pkcs12/projects/opencode/docs/events/event_20260309_workspace_event_reducer_consumption.md`
- `/home/pkcs12/projects/opencode/packages/opencode/src/project/workspace/*`
- `/home/pkcs12/projects/opencode/packages/app/src/context/global-sync/*`

### OUT

- 本輪不直接重寫 dirty bubble runtime implementation
- 不在本輪新增 server route / SDK schema
- 不把 beta spec 原文整份搬進 repo

## 任務清單

- [x] 回讀 workspace 主幹 event / runtime code，盤點可重用抽象
- [x] 更新 `docs/ARCHITECTURE.md` 的 workspace abstraction layer 專章
- [x] 新增 session-owned file diff attribution design note
- [x] 更新 validation 與 Architecture Sync 記錄

## Debug Checkpoints

### Baseline

- `ARCHITECTURE.md` 對 workspace 僅有零散段落，尚未形成完整 abstraction layer 專章。
- app 端目前已有 `/workspace/current` 與 `workspace.*` event consumption，但 dirty/review ownership 還沒有正式 runtime contract。
- 近期 dirty bubble 修正偏向 app-side heuristic，使用者希望優先回到既有 workspace 架構設計，避免重複造輪子。

### Execution

- 回讀 workspace 主幹文件與 runtime code 後，確認目前 repo 已有可重用的 authoritative pieces：
  - `packages/opencode/src/project/workspace/types.ts` 的 `WorkspaceAggregate`
  - `packages/opencode/src/project/workspace/service.ts` 的 registry / attachment / lifecycle / event publish seam
  - `packages/app/src/context/global-sync/bootstrap.ts` 對 `/workspace/current` 的 bootstrap consumption
  - `packages/app/src/context/global-sync/event-reducer.ts` 對 `workspace.*` live events 的 child-store 更新
- 依此補強 `docs/ARCHITECTURE.md`：新增完整的 `Workspace Abstraction Layer` 專章，明確記錄
  - canonical entities（project / workspace / session / attachments）
  - runtime authority split
  - app bootstrap + event-driven data flow
  - ownership rules by surface
  - dirty/review/file-change boundary
  - invalidation / refresh contract
- 另外新增設計文件：`docs/events/event_20260309_session_owned_file_diff_attribution_design.md`
  - 定義為何目前 app-side dirty heuristic 不應視為 end-state
  - 指出長期正解應為 runtime-owned `session mutation ledger + attribution contract`
  - 建議 rollout phases 與 output shape

### Validation

- 已更新：`/home/pkcs12/projects/opencode/docs/ARCHITECTURE.md` ✅
- 已新增：`/home/pkcs12/projects/opencode/docs/events/event_20260309_session_owned_file_diff_attribution_design.md` ✅
- Architecture Sync: Updated
  - 依據：本輪直接補入 workspace abstraction layer 的 current-state architecture truth，並將對應設計決策文件納入 reference decision records。
