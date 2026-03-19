# Event: TUI Sidebar Workdir Changes Fix

**Date**: 2026-03-20
**Branch**: `cms`

## Requirement

- 使用者回報 TUI sidebar 的 `Changes` 沒有正確反映目前 workdir 中的 uncommitted files。
- 目標是讓 sidebar `Changes` 顯示目前 workdir 的 git dirty file list，而不是 session-owned subset。

## Scope

### IN

- `packages/opencode/src/cli/cmd/tui/context/sync.tsx`
- `packages/opencode/src/cli/cmd/tui/routes/session/sidebar.tsx`
- `specs/architecture.md` sync check

### OUT

- backend `session.diff` contract
- webapp review/session-owned diff behavior
- 任何新的 fallback mechanism

## Task Checklist

- [x] 讀取 architecture / event 文件並確認既有 Changes contract
- [x] 追查 TUI sidebar `Changes` 的實際資料來源
- [x] 將 sidebar `Changes` 改為顯示 workdir uncommitted files
- [x] 執行型別驗證並記錄結果
- [x] 完成 architecture sync 記錄

## Debug Checkpoints

### Baseline

- 症狀：sidebar 顯示 `Changes (Clean)`，但 repo `git status --short` 仍有多個 uncommitted files。
- 重現：在 `/home/pkcs12/projects/opencode` 開啟 TUI session sidebar，觀察 `Changes` 區塊。
- 影響：TUI 使用者誤以為 workdir 乾淨。

### Instrumentation Plan

- 檢查 sidebar 顯示來源是否綁定 `session_diff` 或 `file.status`。
- 檢查 TUI sync bootstrap / session sync 時是否有 workspace-level git status 可用。
- 對照 `session.diff` route contract 與 `file.status` route contract。

### Execution

- 讀 `sidebar.tsx` 後確認 `diff()` 直接取 `sync.data.session_diff[sessionID]`。
- 讀 `sync.tsx` 後確認 `session.sync()` 只抓 `sdk.client.session.diff({ sessionID })`。
- 讀 `server/routes/session.ts` 與 `project/workspace/owned-diff.ts` 後確認 `session.diff` 的語義是 authoritative session-owned dirty diff，不是 whole-workdir status。
- 讀 `server/routes/file.ts` 後確認 `file.status` 才是 whole project/workdir git status API。

### Root Cause

- causal chain：TUI sidebar `Changes` → 綁定 `session_diff` → `session.diff` route 回傳 session-owned dirty diff → 當目前 session 未擁有任何 dirty file 時顯示 `Clean`，即使 workdir 仍有其他 uncommitted files。
- 根因不是 git status 計算失敗，而是 UI 區塊名稱/使用者預期是 workdir level，但 TUI 實作誤用了 session-owned data source。

### Fix

- 在 TUI sync store 新增 `workspace_diff[sessionID]`，於 `session.sync()` 時用 session directory 呼叫 `sdk.client.file.status(...)`。
- sidebar `Changes` 改讀 `workspace_diff`，逐項顯示 `item.path`。
- 空狀態文案改為 `No uncommitted workdir files`，對齊新語義。

### Validation

- `bunx tsc --noEmit`：失敗，原因為 Node heap OOM；無法作為本次 slice 的有效驗證。
- `bunx tsc -p packages/opencode/tsconfig.json --noEmit`：失敗，但錯誤集中在 repo 既有型別問題（`bus/index.ts`, `cron/*`, `server/routes/session.ts`, `tool/plan.ts`）與 sidebar 既存 `wrapMode="truncate"` 問題；本次新增的 `workspace_diff` 資料流未產生新的型別錯誤。
- 邏輯驗證：已確認 child session 輪詢與主 session 初載都會呼叫 `sync.session.sync(...)`，因此 `workspace_diff` 會隨既有 session refresh 節奏更新。
- 尚待手動 smoke test：實際打開 TUI sidebar，確認 `Changes` 顯示 workdir dirty files。

## Key Decisions

- 保留 `session.diff` 原 contract，不把 backend session-owned diff 偷偷改成 whole-workdir diff。
- 只在 TUI 加一個明確的 workspace-level source，避免混淆 session review 與 workdir status 兩種語義。

## Verification

- `bunx tsc --noEmit` → OOM，未完成全量驗證
- `bunx tsc -p packages/opencode/tsconfig.json --noEmit` → 發現 repo 既有 TS 錯誤；本次修改未新增新的 `workspace_diff` 相關錯誤
- Pending: TUI sidebar smoke test

## Architecture Sync

- Updated `specs/architecture.md` to separate `session.diff` (session-owned dirty diff) from `file.status` (workspace/workdir git status).
