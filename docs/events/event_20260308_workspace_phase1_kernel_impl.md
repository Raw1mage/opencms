# Event: Workspace Phase 1 kernel implementation

Date: 2026-03-08
Status: Done

## 需求

- 依據 workspace rewrite spec / naming matrix / Phase 1 file plan，在 beta `new-workspace` 分支上建立 workspace kernel 第一版骨架。
- 先實作最小 runtime domain：types / resolver / registry / attachments / index。
- 補最小單元測試，驗證 root/sandbox resolution 與 attachment ownership summarization。

## 範圍

### IN

- `/home/pkcs12/projects/opencode-beta/packages/opencode/src/project/workspace/`
- `/home/pkcs12/projects/opencode-beta/packages/opencode/test/project/`
- `/home/pkcs12/projects/opencode-beta/docs/ARCHITECTURE.md`

### OUT

- 本輪不接 UI consumer
- 不改 DB/schema
- 不做 workspace lifecycle / reset/delete orchestration
- 不做 remote/control-plane

## 任務清單

- [x] 建立 workspace kernel 檔案骨架
- [x] 實作 directory/project → workspace resolver
- [x] 實作最小 registry 與 attachment summary helpers
- [x] 新增最小測試
- [x] 驗證並更新 event / architecture sync

## Debug Checkpoints

### Baseline

- 既有規劃文件已明確把 Phase 1 限定為 kernel，不碰 lifecycle 與 consumer wiring。
- beta runtime 目前只有 `project/worktree/sandbox/directory`，沒有正式 workspace aggregate。
- 若第一版就直接接 consumer，容易把 mixed ownership 問題重新灌回 kernel。

### Execution

- 已新增 `packages/opencode/src/project/workspace/` 第一版 kernel：
  - `types.ts`
  - `attachments.ts`
  - `resolver.ts`
  - `registry.ts`
  - `index.ts`
- 第一版 resolver 能做：
  - directory normalization
  - stable `workspaceId` generation
  - `root` / `sandbox` / `derived` 三種 workspace construction
  - `Project.Info` + directory → workspace aggregate resolution
- 第一版 attachments helper 能做：
  - 空 attachment summary 建立
  - descriptor → summary 收斂
  - 支援 ownership enum：`workspace` / `session` / `session_with_workspace_default`
- 第一版 registry 採 in-memory implementation，刻意不先碰 DB/schema。
- 已開始第一個 consumer adapter path：
  - `packages/app/src/context/global-sync/child-store.ts` 現在會根據 `project + path.worktree + directory` 派生 `store.workspace`
  - app 端新增 `workspace-adapter.ts`，先用純 helper 形式承接 global-sync 的 workspace identity 推導
  - 因 `packages/app` 不能直接 import sibling package source（`rootDir` 邊界），本輪先不直接共享 runtime resolver，改採 app-side adapter；待後續再抽成真正 shared contract
- 已開始第二個 consumer path：
  - `packages/app/src/context/terminal.tsx` 現在會優先使用 `globalSync.child(directory).workspace.directory`
  - terminal persistence/cache key 不再只依賴 route `params.dir`，而是明確對齊 child-store 派生出的 workspace directory
  - 新增 `getWorkspaceTerminalDirectory()`，把 terminal 的 workspace scope 顯式化
- 已開始第三個 consumer path：
  - `packages/app/src/context/prompt.tsx` 現在對 mixed ownership 採明確規則：
    - **有 session id** → 仍以原 session directory 為 scope
    - **沒有 session id** → 改用 `globalSync.child(directory).workspace.directory` 作 workspace fallback scope
  - 新增 `getPromptWorkspaceDirectory()` / `getPromptSessionScopeDirectory()`，把 `session_with_workspace_default` 規則顯式化
- 已開始第四個 consumer path：
  - `packages/app/src/context/comments.tsx` 現在採與 prompt 相同的 mixed ownership 規則：
    - **有 session id** → 使用原 session directory
    - **沒有 session id** → 使用 `globalSync.child(directory).workspace.directory` 作 workspace fallback
  - 新增 `getCommentsWorkspaceDirectory()` / `getCommentsSessionScopeDirectory()`，讓 comments 的 workspace-default 規則顯式化
- 已開始第五個 consumer path：
  - `packages/app/src/context/file/view-cache.ts` 現在採與 prompt/comments 相同的 mixed ownership 規則：
    - **有 session id** → 使用原 session directory
    - **沒有 session id** → 使用 `globalSync.child(directory).workspace.directory` 作 workspace fallback
  - `packages/app/src/context/file.tsx` 已把 child-store 派生出的 workspace directory 傳入 view cache
  - 新增 `getFileViewWorkspaceDirectory()` / `getFileViewSessionScopeDirectory()`，讓 file view 的 workspace-default 規則顯式化
- 測試新增：
  - `packages/opencode/test/project/workspace-resolver.test.ts`
  - `packages/opencode/test/project/workspace-attachments.test.ts`
  - `packages/app/src/context/global-sync/workspace-adapter.test.ts`
  - `packages/app/src/context/global-sync/child-store.test.ts`
  - `packages/app/src/context/terminal.test.ts`
  - `packages/app/src/context/prompt.test.ts`
  - `packages/app/src/context/comments.test.ts`
  - `packages/app/src/context/file/view-cache.test.ts`

### Validation

- `bun test packages/opencode/test/project/workspace-resolver.test.ts packages/opencode/test/project/workspace-attachments.test.ts` ✅
- `bun run --cwd packages/opencode typecheck` ✅
- `bun test --preload ./happydom.ts ./src/context/file/view-cache.test.ts ./src/context/comments.test.ts ./src/context/prompt.test.ts ./src/context/terminal.test.ts ./src/context/global-sync/child-store.test.ts ./src/context/global-sync/workspace-adapter.test.ts` (in `packages/app`) ✅
- `bun run typecheck` (in `packages/app`) ✅
- Architecture Sync: Updated
  - 已同步 `/home/pkcs12/projects/opencode-beta/docs/ARCHITECTURE.md`，補入 `src/project/workspace/*` 模組責任說明。
  - 已同步 app file map：`global-sync/child-store.ts`、`terminal.tsx`、`prompt.tsx`、`comments.tsx`、`file/view-cache.ts` 的 mixed ownership / workspace-default 規則。
  - 已新增 WebApp runtime ownership 章節，說明目前 app 端 `workspace-owned` 與 `session-with-workspace-default` 的分層。
