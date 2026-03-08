# Event: Workspace event reducer consumption

Date: 2026-03-09
Status: Done

## 需求

- 讓 app `global-sync` directory reducer 能消費 live `workspace.*` 事件。
- 使 child store 的 workspace aggregate 不只靠 bootstrap / direct POST response 更新。

## 範圍

### IN

- `/home/pkcs12/projects/opencode-beta/packages/app/src/context/global-sync/event-reducer.ts`
- `/home/pkcs12/projects/opencode-beta/packages/app/src/context/global-sync/event-reducer.test.ts`
- `/home/pkcs12/projects/opencode-beta/docs/ARCHITECTURE.md`

### OUT

- 不處理 preview runtime modeling
- 不改 global project-level workspace summary refresh 策略
- 不改 server event transport

## 任務清單

- [x] 在 directory reducer 補 workspace event handling
- [x] 補測試
- [x] 更新 architecture / validation 紀錄

## Debug Checkpoints

### Baseline

- workspace runtime 已發出 `workspace.created/updated/lifecycle.changed/attachment.*`。
- app child store 目前尚未在 event reducer 中處理這些事件。

### Execution

- `global-sync/event-reducer.ts` 現在會處理：
  - `workspace.created`
  - `workspace.updated`
  - `workspace.lifecycle.changed`
  - `workspace.attachment.added`
  - `workspace.attachment.removed`
- 以上事件統一以 payload 內的 `workspace` aggregate 覆寫 child store `workspace`，讓 lifecycle/attachments 能跟著 runtime live 更新。
- `event-reducer.test.ts` 補入 workspace live update 測試。

### Validation

- `bun run --cwd packages/app test:unit -- src/context/global-sync/event-reducer.test.ts` ✅
- `bun run --cwd packages/app typecheck` ✅
- Architecture Sync: Updated
  - 已補入 `context/global-sync.tsx` 作為 directory event orchestrator，註記 workspace child state 開始消費 live `workspace.*` events。
