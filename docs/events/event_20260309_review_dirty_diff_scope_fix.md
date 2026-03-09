# Event: Review Dirty Diff Scope Fix

Date: 2026-03-09
Status: Completed

## 需求

- 修正「檔案異動」視窗目前列出整個 session 累積 diff 的行為。
- 視窗應只顯示當下 git dirty 狀態，而不是歷史累積內容。
- 若可行，進一步讓不同 session 只聚焦自己 session 相關、且目前仍 dirty 的檔案。
- 在對話標題區提供 dirty indicator，快速顯示目前檔案異動數量。

## 範圍 (IN / OUT)

### IN

- `/home/pkcs12/projects/opencode/packages/app/src/pages/session.tsx`
- `/home/pkcs12/projects/opencode/packages/app/src/pages/session/message-timeline.tsx`
- `/home/pkcs12/projects/opencode/packages/app/src/pages/session/helpers.ts`
- `/home/pkcs12/projects/opencode/packages/app/src/pages/session/helpers.test.ts`
- `/home/pkcs12/projects/opencode/packages/app/src/context/sync.tsx`（既有 current-dirty 路徑確認）
- `/home/pkcs12/projects/opencode/packages/app/src/context/global-sync/event-reducer.ts`（既有政策確認）
- `/home/pkcs12/projects/opencode/docs/events/event_20260309_review_dirty_diff_scope_fix.md`

### OUT

- 不重做 session summary snapshot 架構
- 不改 share/export 歷史 diff 的資料模型
- 不擴大調整 review UI 互動

## 任務清單

- [x] 讀取 architecture 與現行 review diff 資料流
- [x] 找出歷史 diff 被誤用成當前 dirty 清單的根因
- [x] 以最小修改修正資料來源/查詢語意
- [x] 補上回歸驗證
- [x] 記錄 Architecture Sync 判定

## Debug Checkpoints

### Baseline

- 使用者回報：「檔案異動」視窗目前列出的 file diff 看起來是有史以來全部累積內容。
- 期望行為：只列出當下 git dirty 狀態，不需要完整歷史資料。
- 初步追查顯示 frontend 會以 `selectedTurnMessageID` 呼叫 `client.session.diff({ sessionID, messageID })`，但結果疑似沒有真的依 message 範圍收斂。

### Execution

- 進一步追查後確認真正問題不在 backend `SessionSummary.diff`，而在 session page 本身仍把 review panel 綁到 `selectedTurnMessageID` + `sync.session.diff(id, { messageID })`。
- 但 `packages/app/src/context/sync.tsx` 其實早已提供無 `messageID` 的 current-dirty 路徑：直接呼叫 `client.file.status()`，並把結果寫入 `session_diff[sessionID]`。
- 同時 `packages/app/src/context/global-sync/event-reducer.ts` 也已明確註記：review panel 應依賴 `git status`，而非 backend `session.diff` event。
- 第一階段最小修正集中在 `packages/app/src/pages/session.tsx`：
  - 移除 review panel 對 `selectedTurnMessageID` 的綁定。
  - `reviewDiffKey` 改為直接使用 `params.id`（sessionID）。
  - 開啟檔案異動視窗時，改呼叫 `sync.session.diff(id)`，讓資料來源走既有的 `client.file.status()` current-dirty 路徑。
- 第二階段再加上 session-scope 過濾：
  - 在 `packages/app/src/pages/session/helpers.ts` 新增 `getSessionScopedDirtyDiffs(...)`。
  - 邏輯為：以「目前 git dirty 清單」為基底，交集過濾目前 session 的 user message `summary.diffs` 曾觸及的檔案。
  - 若 session 尚無可用的 summary diff 歷史，則保守 fallback 成顯示全部 current dirty，避免空白誤判。
- 這樣可讓檔案異動視窗同時滿足：
  - 不再顯示歷史累積 diff。
  - 仍對得到真實 current dirty。
  - 不同 session 可聚焦自己曾動到且目前仍 dirty 的檔案子集。
- 依使用者後續需求，在 `packages/app/src/pages/session/message-timeline.tsx` 的對話標題右側新增 dirty indicator bubble：
  - 使用當前 `reviewCount()` 作為數量來源。
  - 僅在 count > 0 時顯示。
  - 讓使用者不用展開檔案異動畫面，也能快速知道這個 session 目前有多少相關 dirty files。

### Validation

- 驗證指令：
  - `bun test --preload ./happydom.ts ./src/pages/session/helpers.test.ts`
  - `bun turbo typecheck --filter @opencode-ai/app`
- 結果：passed
- Architecture Sync: Verified (No doc changes)
  - 依據：本輪只修正 session page 取用 review diff 的資料來源，未改動架構邊界、API contract 或模組責任。
