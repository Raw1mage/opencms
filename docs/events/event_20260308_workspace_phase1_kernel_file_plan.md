# Event: Workspace Phase 1 kernel file plan

Date: 2026-03-08
Status: Done

## 需求

- 基於已完成的 rewrite spec 與 naming/ownership matrix，產出 Phase 1 workspace kernel 的最小檔案規劃。
- 明確定義 `packages/opencode/src/project/workspace/` 第一版應有哪些檔案、各自責任與最小 API。
- 讓下一步 implementation 可以直接進入「建骨架」而不是再次重做分析。

## 範圍

### IN

- `/home/pkcs12/projects/opencode-beta/docs/specs/workspace-rewrite-spec.md`
- `/home/pkcs12/projects/opencode-beta/docs/specs/workspace-naming-ownership-matrix.md`
- `/home/pkcs12/projects/opencode-beta/packages/opencode/src/project/{project,instance,state,bootstrap}.ts`
- 新文件：`/home/pkcs12/projects/opencode-beta/docs/specs/workspace-phase1-kernel-file-plan.md`

### OUT

- 本輪不新增 runtime code
- 不修改 `packages/opencode/src/project/*`
- 不開始 consumer adapter implementation

## 任務清單

- [x] 重新對齊 rewrite spec 與 matrix 的共同需求
- [x] 確認 `packages/opencode/src/project/` 目前可承接的自然落點
- [x] 設計 Phase 1 最小檔案集與 API 面
- [x] 明確標記哪些內容進 Phase 2 後才做

## Debug Checkpoints

### Baseline

- rewrite spec 已確立 Phase 1 目標為 workspace domain kernel。
- naming/ownership matrix 已證明目前 `workspace` 語義分裂，不能直接由某一個現有欄位升格取代。
- 下一步若沒有 file plan，實作時仍容易在 `child-store`、`terminal`、`Project` 之間來回跳接，導致 API 漂移。

### Execution

- 重新對照 spec 與現有 `project/instance/state/bootstrap` 之後，確認 Phase 1 不應碰 UI，也不應先碰 DB/schema。
- 新 file plan 將 workspace kernel 限定為五個核心模組：
  - `types.ts`
  - `registry.ts`
  - `resolver.ts`
  - `attachments.ts`
  - `index.ts`
- 並把 `lifecycle.ts` 延後到 Phase 2/4，避免第一版過早承擔 reset/delete/archive orchestration。
- 同時定義最小 integration seam：
  - input 來自 `Project.fromDirectory()` / `Project.Info`
  - output 先提供給 `globalSync.child(directory)` 與 terminal consumer

### Validation

- 已新增：`/home/pkcs12/projects/opencode-beta/docs/specs/workspace-phase1-kernel-file-plan.md` ✅
- file plan 已可直接作為下一輪實作骨架藍圖 ✅
- Architecture Sync: Verified (No doc changes)
  - 依據：本輪僅補 Phase 1 設計文檔，未改動 beta 當前 architecture/runtime truth。
