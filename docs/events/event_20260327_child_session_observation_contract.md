# Event: Child Session Observation Contract

**Date**: 2026-03-27
**Plan**: `/home/pkcs12/projects/opencode/plans/20260327_cron-manager-debug-web-cron-task-list-task/`
**Beta Branch**: `feature/subsession-readonly-killswitch`
**Beta Worktree**: `/home/pkcs12/projects/.beta-worktrees/opencode/feature/subsession-readonly-killswitch`

## Requirement

使用者要求收斂 subagent/child session 的產品 contract：

1. child session 不應出現可提交的對話輸入框
2. child session 應是 observation-only surface，而非可直接對話的 session
3. 當 child 正在執行時，應有明確可見的 kill/stop control，讓操作者知道它仍在跑
4. child page / bottom status / session list 需對同一 authoritative active child 保持一致

## Scope

### IN
- child session prompt dock 改為唯讀 observation-only placeholder
- child session 僅在自己就是 authoritative active child 時顯示 stop control
- 透過既有 parent-session abort contract 停止 child
- 以 beta workflow 完成實作並 fetch-back 回主 repo

### OUT
- 不支援 child session 對話接管
- 不重做 worker lifecycle / IPC
- 不引入新的 child-local fallback stop path

## Task Checklist Status

- `1.1` ~ `1.3` ✅
- `2.1` ~ `2.3` ✅
- `3.1` ~ `3.3` ✅
- `4.1` 진행中（本 event）
- `4.2` 待比對回顧

## Debug / Build Checkpoints

### Baseline
- 原本 child session 仍顯示可提交 `PromptInput`
- 沒有明確 child-page stop control，若 child 沒持續輸出文字，操作者難以確認是否仍在跑
- 先前 stale running projection 問題已另案修復，這次在此基礎上收斂 child observation contract

### Implementation Strategy
- 使用 `session.parentID` 作為 child session 判定信號
- 使用 parent authoritative `active_child[parentSessionID]` 作為 child-page dock 的可見性 authority
- 只在當前頁面就是 active child 本人時顯示 dock stop control
- stop 行為重用既有 `sdk.client.session.abort({ sessionID: parentSessionID })`

### Execution
- Beta worktree first implementation:
  - `packages/app/src/pages/session/session-prompt-dock.tsx`
  - `packages/app/src/pages/session.tsx`
- 主 repo plan checklist 即時同步到 `tasks.md`
- Beta branch commit:
  - `e74c07328 fix: make child sessions observation-only`
- Fetch-back completed to main repo branch `feature/subsession-readonly-killswitch`

### Root Cause / Product Decision Summary
- child session 既然代表 subagent worker transcript，就不應再提供 conversational input surface；這會破壞 parent/child orchestration boundary。
- 執行中的 child 需要明確 stop affordance，不應依賴是否有持續文字輸出來讓使用者猜測是否仍在跑。
- running indicator / stop control 必須服從 authoritative active-child state，而不是 child transcript 自己推估。

## Changes

- `packages/app/src/pages/session.tsx`
  - 以 `info()?.parentID ?? params.id` 推導 authoritative parent session id
  - child session 頁面只在 `dock.sessionID === currentSessionID` 時顯示 active child dock
  - 注入 `isChildSession` 與 `onAbortActiveChild()` 到 prompt dock
- `packages/app/src/pages/session/session-prompt-dock.tsx`
  - child session 改成 observation-only placeholder，不再渲染 submit-capable `PromptInput`
  - active child dock 新增 `Stop` button
  - stop button 顯示 `Stopping…` 過渡狀態

## Verification

### Beta-side evidence
- Beta diff 僅集中於 `session.tsx` 與 `session-prompt-dock.tsx`
- `tasks.md` 已同步勾選 `1.x`, `2.x`, `3.x`

### Main repo fetch-back evidence
- `beta-tool_syncback` returned `status: ok`
- main repo current branch: `feature/subsession-readonly-killswitch`
- fetched code now present in main worktree

### Static verification
- Child session no longer receives submit-capable `PromptInput` (`session-prompt-dock.tsx`)
- Child page stop action uses existing parent abort contract (`session.tsx`)
- Dock visibility is restricted to authoritative active child matching current child page (`visibleChildDock`)

### Runtime note
- 本輪 `bun x tsc -p packages/app/tsconfig.json --noEmit` 在工具輸出未完整回傳結果；仍需使用者於 reload 後做一次 web smoke validation 以補最終 UI/runtime evidence

## Key Decisions

1. child session 保留 dock 區域，但改成唯讀 placeholder，而非整塊移除。
2. kill/stop control 放在 child prompt dock 上方的 active-child card 中。
3. stop control 不另開新 API，而是沿用 parent session abort contract。
4. 只讓當前 child 頁面在自身仍是 authoritative active child 時顯示 stop control，避免非 active child 誤顯示 running affordance。

## Architecture Sync

Architecture Sync: Verified (No doc changes)

Basis:
- 本次變更是在既有 active-child control surface 與 session page UI contract 內做產品邊界收斂。
- 未新增模組邊界、資料流或新的 worker lifecycle state machine。

## Remaining

- `4.2`：需再做一次 implementation vs proposal effective requirement description 對照收尾
- 建議 reload/restart web runtime 後，手動驗證：
  1. child session 顯示 observation-only placeholder
  2. running child 顯示 Stop
  3. 點 Stop 後 child page / status bar / session list 一致收斂
