# Event: Workspace bus events

Date: 2026-03-09
Status: Done

## 需求

- 為 workspace runtime service 補上正式 bus event contract。
- 讓 attachment 與 lifecycle 更新能被統一觀察，而不是各 consumer 自己推導。

## 範圍

### IN

- `/home/pkcs12/projects/opencode-beta/packages/opencode/src/project/workspace/`
- `/home/pkcs12/projects/opencode-beta/packages/opencode/test/project/`
- `/home/pkcs12/projects/opencode-beta/docs/ARCHITECTURE.md`

### OUT

- 本輪不做 preview attachment runtime modeling
- 本輪不引入持久化 workspace registry
- 本輪不改 web/TUI consumer 到新 event stream

## 任務清單

- [x] 定義 workspace bus events
- [x] 在 service lifecycle / attachment mutation 後發佈事件
- [x] 補事件測試
- [x] 更新 architecture / validation 紀錄

## Debug Checkpoints

### Baseline

- workspace service 已能管理 session / pty / worker attachments 與 lifecycle 狀態。
- 但目前缺少 `workspace.*` bus contract，consumer 仍無法可靠訂閱 workspace 層級變化。

### Execution

- 新增 `packages/opencode/src/project/workspace/events.ts`，定義：
  - `workspace.created`
  - `workspace.updated`
  - `workspace.lifecycle.changed`
  - `workspace.attachment.added`
  - `workspace.attachment.removed`
- `WorkspaceService` 現在透過集中 `upsertAndPublish()` 對 register / attachment mutation / lifecycle mutation 發佈統一事件。
- attachment diff 以 descriptor `(type,key)` 比對新增/移除，避免 consumer 再從 aggregate 手動猜差異。
- lifecycle mutation 會帶 `previousState` / `nextState`，讓 observer 直接消費狀態轉移。
- `workspace-service.test.ts` 補上 created/updated、attachment added/removed、lifecycle changed 事件測試。

### Validation

- `bun test packages/opencode/test/project/workspace-service.test.ts packages/opencode/test/project/workspace-resolver.test.ts packages/opencode/test/project/workspace-attachments.test.ts packages/opencode/test/project/workspace-lifecycle.test.ts` ✅
- `bun run --cwd packages/opencode typecheck` ✅
- Architecture Sync: Updated
  - `docs/ARCHITECTURE.md` 已補入 workspace kernel 現在提供 `WorkspaceEvent` bus contract。
