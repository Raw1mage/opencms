# Event: Workspace delete operation runtime

Date: 2026-03-09
Status: Done

## 需求

- 把 workspace delete 前後的 backend orchestration 從 app 收回 runtime。
- 本輪至少收回：session archive + instance dispose + worktree remove + project sandbox removal。

## 範圍

### IN

- `/home/pkcs12/projects/opencode-beta/packages/opencode/src/project/workspace/`
- `/home/pkcs12/projects/opencode-beta/packages/opencode/src/server/routes/workspace.ts`
- `/home/pkcs12/projects/opencode-beta/packages/app/src/pages/layout.tsx`
- `/home/pkcs12/projects/opencode-beta/docs/ARCHITECTURE.md`

### OUT

- 不處理 preview runtime
- 不把 terminal cleanup 收進 runtime
- 不全面清理 delete 後所有 app-local UI side effects（仍保留 close/open/navigate）

## 任務清單

- [x] 定義 runtime delete operation
- [x] 接上 workspace route
- [x] 精簡 app delete orchestration
- [x] 補測試 / 文件 / architecture

## Debug Checkpoints

### Baseline

- app delete flow 仍自行做 lifecycle transition + `worktree.remove` + project sandbox local mutation。
- backend side effect 長期留在 layout UI，與 reset flow 已收回 runtime 的方向不一致。

### Execution

- `packages/opencode/src/project/workspace/operation.ts` 新增 `WorkspaceOperation.delete()`：
  - 標記 workspace `deleting`
  - archive active sessions
  - dispose directory instance state
  - remove worktree
  - remove project sandbox metadata
  - 成功後標記 `archived`，失敗則標記 `failed`
- `server/routes/workspace.ts` 新增 `POST /workspace/:workspaceID/delete-run`
- `pages/layout.tsx` 的 delete flow 已移除：
  - app-side lifecycle mutation calls
  - direct `worktree.remove()` backend call
- app 現在只保留：
  - runtime operation call
  - local project/workspace-order UI cleanup
  - navigation / layout UI handling

### Validation

- `bun test packages/opencode/test/project/workspace-operation.test.ts packages/opencode/test/project/workspace-service.test.ts packages/opencode/test/project/workspace-resolver.test.ts packages/opencode/test/project/workspace-attachments.test.ts packages/opencode/test/project/workspace-lifecycle.test.ts` ✅
- `bun run --cwd packages/opencode typecheck` ✅
- `bun run --cwd packages/app test:unit -- src/context/global-sync/event-reducer.test.ts src/context/global-sync/bootstrap.test.ts src/context/global-sync/child-store.test.ts` ✅
- `bun run --cwd packages/app typecheck` ✅
- Architecture Sync: Updated
  - `docs/ARCHITECTURE.md` 已補上 runtime-owned delete operation 與 route 說明。
