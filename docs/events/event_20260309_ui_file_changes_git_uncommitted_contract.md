# Event: UI File Changes Git-Uncommitted Contract

Date: 2026-03-09
Status: In Progress

## 需求

- 重新定義 TUI / webapp 的 `Changes` / `檔案異動` contract。
- UI 應以「當下仍未 commit，且屬於該 session 的檔案」為主語意，而不是整個 workspace 的 raw git dirty 清單。
- 釐清目前 runtime / frontend 實作是否仍混用 session-owned dirty diff，並規劃替換路徑。

## 範圍 (IN / OUT)

### IN

- `/home/pkcs12/projects/opencode/packages/app/src/context/sync.tsx`
- `/home/pkcs12/projects/opencode/packages/app/src/pages/session.tsx`
- `/home/pkcs12/projects/opencode/packages/app/src/pages/layout/sidebar-items.tsx`
- `/home/pkcs12/projects/opencode/packages/app/src/components/prompt-input.tsx`
- `/home/pkcs12/projects/opencode/packages/opencode/src/cli/cmd/tui/context/sync.tsx`
- `/home/pkcs12/projects/opencode/packages/opencode/src/cli/cmd/tui/routes/session/sidebar.tsx`
- `/home/pkcs12/projects/opencode/packages/opencode/src/server/routes/session.ts`
- `/home/pkcs12/projects/opencode/packages/opencode/src/server/routes/file.ts`
- `/home/pkcs12/projects/opencode/packages/opencode/src/project/workspace/owned-diff.ts`
- `/home/pkcs12/projects/opencode/packages/opencode/src/file/index.ts`
- `/home/pkcs12/projects/opencode/docs/events/event_20260309_ui_file_changes_git_uncommitted_contract.md`
- `/home/pkcs12/projects/opencode/docs/ARCHITECTURE.md`（若 contract/boundary 需更新）

### OUT

- 不在本輪把所有 session 都改成顯示整個 workspace 的 raw git dirty 清單
- 不在未確認前直接刪除 `session.diff` 的 message-level summary diff 用途
- 不在未盤點完所有 surface 前直接修改 SDK schema

## 任務清單

- [x] 盤點 webapp / TUI 目前所有 `session.diff` UI 使用點
- [x] 釐清 backend `session.diff` 與 `File.status()` 的實際語意
- [x] 定義 UI end-state contract：current dirty ∩ session-owned files
- [x] 確認 `session.diff` 已具備 current-dirty session attribution 基礎語意
- [x] 修正 TUI / webapp，避免誤把 whole-workspace `file.status` 當成每個 session 的 count
- [ ] 驗證並更新 Architecture Sync

## Debug Checkpoints

### Baseline

- 目前 webapp 與 TUI 的 `Changes` / `檔案異動` 均直接消費 `session.diff`：
  - webapp：`packages/app/src/context/sync.tsx`, `packages/app/src/pages/session.tsx`, `packages/app/src/pages/layout/sidebar-items.tsx`, `packages/app/src/components/prompt-input.tsx`
  - TUI：`packages/opencode/src/cli/cmd/tui/context/sync.tsx`, `packages/opencode/src/cli/cmd/tui/routes/session/sidebar.tsx`
- backend `GET /session/:sessionID/diff` 在 `messageID` 缺省時，回傳的是 `getSessionOwnedDirtyDiff(...)`，其描述明確為 `session-owned dirty diff`。
- `getSessionOwnedDirtyDiff(...)` 並非純歷史累積；它會先讀 `File.status()` 取得當前 dirty files，再和：
  - session touched files
  - latest summary diff
    做交集。
- 使用者進一步澄清：UI 的 per-session count 應是「現在還沒 commit，且屬於該 session 的檔案」，不能把其他 session 造成的 dirty 一起算進來。

### Execution

- 已確認 `File.status()` 實作基於 git working tree：
  - `git diff --numstat HEAD`
  - `git ls-files --others --exclude-standard`
  - `git diff --name-only --diff-filter=D HEAD`
- 已確認目前 UI 並**沒有**在前端拿 `session.diff` 後再做第二次 git diff 過濾；真正的過濾都在 backend `session.diff` 內完成。
- 因此正確 contract 不是直接把 UI 換到 `file.status()`，而是：
  - `file.status()` = raw current workspace git truth
  - `session.diff` (without `messageID`) = current dirty ∩ session ownership
  - per-session UI 應消費後者，而不是前者
- 本輪修正決策：
  - 保留 `session.diff` 作為 per-session `Changes` / dirty count 主資料源
  - 保留 `session.diff({ sessionID, messageID })` 作為 message-level review/history 路徑
  - `file.status()` 只視為 lower-level primitive，不再直接拿來驅動每個 session 的 UI count
- 已完成的實作調整：
  - `packages/app/src/context/sync.tsx`
    - `sync.session.diff(sessionID)` 恢復為抓 `client.session.diff({ sessionID })`
    - `sync.session.diff(sessionID, { messageID })` 保留 message-level summary diff
  - `packages/app/src/pages/session.tsx`
    - review/dirty bubble/file tree 恢復讀取 `session_diff[sessionID]`
    - 仍保留 `force: true` refresh，避免 webapp 顯示 stale per-session count
  - `packages/app/src/pages/layout/sidebar-items.tsx`
    - session row dirty bubble 恢復使用 `session_diff[sessionID]`
  - `packages/app/src/components/prompt-input.tsx`
    - review comment routing 恢復以 `session_diff[sessionID]` 判斷
  - `packages/opencode/src/cli/cmd/tui/context/sync.tsx`
    - session sync 恢復 hydrate `session.diff({ sessionID })`
  - `packages/opencode/src/cli/cmd/tui/routes/session/sidebar.tsx`
    - `Changes` 清單恢復顯示該 session 的 runtime-owned current dirty diff

### Validation

- 驗證指令：
  - `bun run typecheck`（workdir: `/home/pkcs12/projects/opencode/packages/app`）
  - `bun run --cwd /home/pkcs12/projects/opencode/packages/opencode typecheck`
- 結果：passed
- Architecture Sync: Updated
  - 依據：澄清 per-session UI `Changes` contract 應為 current dirty ∩ session-owned attribution，而不是 whole-workspace `file.status`；已同步修正 `docs/ARCHITECTURE.md` 邊界描述。
