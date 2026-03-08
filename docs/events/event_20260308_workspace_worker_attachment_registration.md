# Event: Workspace worker attachment registration

Date: 2026-03-08
Status: Done

## 需求

- 把 runtime subagent/task worker 納入 workspace attachment model。
- 優先處理 worker；preview 因尚未有獨立 runtime domain/event source，本輪先明確延後。

## 範圍

### IN

- `/home/pkcs12/projects/opencode-beta/packages/opencode/src/tool/task.ts`
- `/home/pkcs12/projects/opencode-beta/packages/opencode/src/project/workspace/service.ts`
- `/home/pkcs12/projects/opencode-beta/packages/opencode/test/project/`
- `/home/pkcs12/projects/opencode-beta/docs/ARCHITECTURE.md`

### OUT

- 本輪不做 preview attachment registration
- 不建立 preview lifecycle / cleanup policy

## 任務清單

- [x] 為 task worker 建立 bus event contract
- [x] 讓 WorkspaceService 訂閱 worker event 並寫回 attachment summary
- [x] 補 focused tests
- [x] 更新 architecture / validation 紀錄

## Debug Checkpoints

### Baseline

- workspace attachments 目前已覆蓋 session / pty，但 worker 尚未納入。
- preview 缺少清晰 runtime domain，因此不能硬塞假模型。

### Execution

- `tool/task.ts` 新增 `TaskWorkerEvent`：
  - `Assigned`
  - `Done`
  - `Failed`
  - `Removed`
- `WorkspaceService` 現在提供：
  - `attachWorker({ workerID, sessionID })`
  - `detachWorker({ workerID })`
- worker attachment 以 `sessionID -> Session.get() -> session.directory` 解析 workspace 歸屬。
- `initEventSubscriptions()` 已開始訂閱 task worker events，讓 worker 生命週期能回寫 workspace attachment summary。
- worker `done` 但 `ok=false` 的終止路徑也明確發出 `Failed` event，避免 attachment 遺留。
- preview attachment 明確延後，直到有真正 preview runtime/event model。

### Validation

- `bun test packages/opencode/test/project/workspace-resolver.test.ts packages/opencode/test/project/workspace-attachments.test.ts packages/opencode/test/project/workspace-service.test.ts packages/opencode/test/project/workspace-lifecycle.test.ts` ✅
- `bun run --cwd packages/opencode typecheck` ✅
- Architecture Sync: Updated
  - 已同步 architecture file map，註記 workspace service 現在開始承接 worker attachments；preview 尚未進場。
