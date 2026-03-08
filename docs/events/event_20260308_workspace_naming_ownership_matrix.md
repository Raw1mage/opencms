# Event: Workspace naming and ownership matrix

Date: 2026-03-08
Status: Done

## 需求

- 盤點 beta repo 目前所有 `workspace` / `worktree` / `sandbox` / `directory` 相關命名與實際用途。
- 明確區分哪些是 UI workspace、哪些是 persistence scope、哪些是 runtime project boundary。
- 為後續 Phase 1 workspace kernel 提供 naming/ownership 基線。

## 範圍

### IN

- `/home/pkcs12/projects/opencode-beta/packages/app/src/pages/layout*.tsx`
- `/home/pkcs12/projects/opencode-beta/packages/app/src/context/{layout,terminal,prompt,file,comments}.tsx`
- `/home/pkcs12/projects/opencode-beta/packages/app/src/context/global-sync/child-store.ts`
- `/home/pkcs12/projects/opencode-beta/packages/opencode/src/project/{project,instance}.ts`
- 新文件：`/home/pkcs12/projects/opencode-beta/docs/specs/workspace-naming-ownership-matrix.md`

### OUT

- 本輪不改 runtime code
- 不改 schema / API
- 不直接做 workspace kernel implementation

## 任務清單

- [x] 搜尋目前 workspace 相關命名落點
- [x] 區分 UI / persistence / runtime boundary 三種語義
- [x] 寫出 naming/ownership matrix
- [x] 記錄風險、衝突與下一步

## Debug Checkpoints

### Baseline

- rewrite spec 已確立：workspace 要升級為 execution scope。
- 但 beta 現況的 `workspace` 仍混合指涉 sidebar 節點、session grouping、persist key 與 project boundary。
- 若不先盤點命名與 ownership，Phase 1 kernel 很容易延續目前的語義混用。

### Execution

- 盤點結果顯示目前至少存在四層不同語義：
  1. **Project root**：`Project.Info.worktree` 為 repository/root 邊界。
  2. **Sandbox child directory**：`Project.Info.sandboxes[]` 為 child worktree / sandbox 清單。
  3. **UI workspace**：layout/sidebar 將 root + sandboxes 都包裝成 workspace item。
  4. **Persistence scope**：terminal / prompt / comments / file-view / global-sync 等多處以 `directory` 或 `dir + sessionId` 作 scope key。
- 特別重要發現：
  - terminal 是 **workspace-scoped**（純 directory）
  - prompt/comments/file-view 是 **session-first with workspace fallback**
  - layout/sidebar 的 `workspaceKey()` 只做 path normalization，不是正式 identity
  - runtime `Instance` / `Project` 仍以 `directory` + `worktree` + `sandbox` 為主，尚無正式 workspace aggregate

### Validation

- 已新增：`/home/pkcs12/projects/opencode-beta/docs/specs/workspace-naming-ownership-matrix.md` ✅
- matrix 已可回答「每個 workspace 名詞目前到底在代表什麼」✅
- Architecture Sync: Verified (No doc changes)
  - 依據：本輪為 naming/ownership 盤點與 spec 補充，未改動 beta 當前 architecture/runtime truth。
