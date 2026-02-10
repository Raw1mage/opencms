# Event: Monitor UX Refinement

Date: 2026-02-11
Status: Done

## Goal

改善 TUI Sidebar 的 Monitor 體驗，並移除與 Monitor 重複的 Subagents 列表。

## Changes

1. Sidebar Monitor fallback
   - 檔案：`/home/pkcs12/opencode/packages/opencode/src/cli/cmd/tui/routes/session/sidebar.tsx`
   - 調整：當 monitor active 清單為空時，強制顯示當前 session 的一筆 fallback 狀態。
   - 目的：即使只有 main session 且沒有 active job，使用者仍可看見 main session 狀態（至少 `idle/Done`）。

2. Subsession title quality
   - 檔案：`/home/pkcs12/opencode/packages/opencode/src/tool/task.ts`
   - 調整：建立 sub-session 時，根據 `description` + `prompt` 內容產生更具語意的標題。
   - 目的：避免子會話標題過度 generic，提升任務可辨識性。

3. Hide Subagents block in sidebar
   - 檔案：`/home/pkcs12/opencode/packages/opencode/src/cli/cmd/tui/routes/session/sidebar.tsx`
   - 調整：移除 Sidebar 的 Subagents 區塊，避免與 Monitor 重複。

## Validation

- `bun test /home/pkcs12/opencode/packages/opencode/test/permission-task.test.ts /home/pkcs12/opencode/packages/opencode/test/session/session.test.ts`
- 結果：All pass
