# Event: Workspace reset operation runtime

Date: 2026-03-09
Status: Done

## 需求

- 把 workspace reset 前後的 backend orchestration 從 app 收回 runtime。
- 本輪至少收回：session archive + instance dispose + worktree reset。

## 範圍

### IN

- `/home/pkcs12/projects/opencode-beta/packages/opencode/src/project/workspace/`
- `/home/pkcs12/projects/opencode-beta/packages/opencode/src/server/routes/workspace.ts`
- `/home/pkcs12/projects/opencode-beta/packages/app/src/pages/layout.tsx`
- `/home/pkcs12/projects/opencode-beta/docs/ARCHITECTURE.md`

### OUT

- 不處理 preview runtime
- 不把 terminal cleanup 收進 runtime（仍屬 app/local surface）
- delete flow 若無法自然收斂，本輪可只先處理 reset

## 任務清單

- [x] 定義 runtime reset operation
- [x] 接上 workspace route
- [x] 精簡 app reset orchestration
- [x] 補測試 / 文件 / architecture

## Debug Checkpoints

### Baseline

- app reset flow 仍自行做 session.list + session.archive + instance.dispose + worktree.reset。
- 這些屬於 backend/runtime side effect，不應長期留在 layout UI。

### Execution

- 新增 `packages/opencode/src/project/workspace/operation.ts`，提供 `WorkspaceOperation.reset()`：
  - 讀取 workspace aggregate
  - 將 sandbox workspace 標記為 `resetting`
  - 列出並 archive 尚未 archived 的 sessions
  - dispose 該 directory instance state
  - 在 project root instance context 下呼叫既有 `Worktree.reset({ directory })`
  - 成功後標記回 `active`，失敗則標記 `failed`
- `server/routes/workspace.ts` 新增 `POST /workspace/:workspaceID/reset-run`。
- `pages/layout.tsx` 的 reset flow 已移除以下 backend orchestration：
  - `session.list`
  - `session.update(... archived)`
  - `instance.dispose`
  - `worktree.reset`
- app 現在只保留：
  - local terminal cleanup
  - runtime operation call
  - toast/navigation UI handling

### Validation

- `bun test packages/opencode/test/project/workspace-operation.test.ts packages/opencode/test/project/workspace-service.test.ts packages/opencode/test/project/workspace-resolver.test.ts packages/opencode/test/project/workspace-attachments.test.ts packages/opencode/test/project/workspace-lifecycle.test.ts` ✅
- `bun run --cwd packages/opencode typecheck` ✅
- `bun run --cwd packages/app test:unit -- src/context/global-sync/event-reducer.test.ts src/context/global-sync/bootstrap.test.ts src/context/global-sync/child-store.test.ts` ✅
- `bun run --cwd packages/app typecheck` ✅
- Architecture Sync: Updated
  - `docs/ARCHITECTURE.md` 已註記 workspace route 與 workspace kernel 現在包含第一個 runtime-owned reset operation。
