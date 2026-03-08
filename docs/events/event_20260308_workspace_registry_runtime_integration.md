# Event: Workspace registry runtime integration

Date: 2026-03-08
Status: Done

## 需求

- 在 runtime 側補上第一個真正使用 workspace registry 的整合入口。
- 避免後續 consumer 每次都要自己手動 `resolveWorkspace` 再 `upsert`。
- 用最小可驗證方式把 registry 從「存在但未被整合」推進到「可作為 runtime lookup seam」。

## 範圍

### IN

- `/home/pkcs12/projects/opencode-beta/packages/opencode/src/project/workspace/{resolver,registry,index}.ts`
- `/home/pkcs12/projects/opencode-beta/packages/opencode/test/project/`

### OUT

- 本輪不接 server route
- 不接 app 直接讀 runtime registry
- 不做 workspace lifecycle orchestration

## 任務清單

- [x] 設計最小 registry integration API
- [x] 實作 runtime resolve+register helper
- [x] 補測試驗證 registry roundtrip
- [x] 更新 Validation / Architecture Sync 記錄

## Debug Checkpoints

### Baseline

- 目前 workspace registry 已存在，但還停留在裸介面 + in-memory implementation。
- resolver 與 registry 之間缺少單一整合入口，導致後續 consumer 仍可能重複 `resolve -> upsert -> get` 流程。

### Execution

- 新增 `resolveWorkspaceWithRegistry({ directory, registry })` 作為 runtime 第一個 registry integration seam。
- 行為規則：
  - 先以 normalized directory 查 registry
  - 命中則直接回傳
  - 未命中才走 `resolveWorkspace()`，並把結果 `upsert` 回 registry
- 這讓後續 runtime consumer 不需要自己手動做 `resolve -> upsert -> get` 三段流程。
- 補測試確認：
  - 相同 directory 即使輸入有 trailing slash 差異，仍只會得到同一份 normalized workspace aggregate
  - registry 可用 `getByDirectory` / `listByProject` 正常回取結果

### Validation

- `bun test packages/opencode/test/project/workspace-resolver.test.ts packages/opencode/test/project/workspace-attachments.test.ts` ✅
- `bun run --cwd packages/opencode typecheck` ✅
- Architecture Sync: Verified (No doc changes)
  - 依據：本輪是對既有 Phase 1 kernel 補上 runtime registry integration seam，未改變 architecture 的整體分層與責任敘述。
