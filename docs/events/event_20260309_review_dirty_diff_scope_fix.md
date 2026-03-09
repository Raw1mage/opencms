# Event: Review Dirty Diff Scope Fix

Date: 2026-03-09
Status: Completed

## 需求

- 修正「檔案異動」視窗目前列出整個 session 累積 diff 的行為。
- 視窗應只顯示當下 git dirty 狀態，而不是歷史累積內容。
- 若可行，進一步讓不同 session 只聚焦自己 session 相關、且目前仍 dirty 的檔案。
- 在對話標題區提供 dirty indicator，快速顯示目前檔案異動數量。
- 在 session list row 上也提供 dirty count bubble，方便快速掃描多個 session。
- webapp session list 已有清楚層級時，不需要再在標題前綴 `[repo]`。

## 範圍 (IN / OUT)

### IN

- `/home/pkcs12/projects/opencode/packages/app/src/pages/session.tsx`
- `/home/pkcs12/projects/opencode/packages/app/src/pages/session/message-timeline.tsx`
- `/home/pkcs12/projects/opencode/packages/app/src/pages/session/helpers.ts`
- `/home/pkcs12/projects/opencode/packages/app/src/pages/session/helpers.test.ts`
- `/home/pkcs12/projects/opencode/packages/app/src/components/dirty-count-bubble.tsx`
- `/home/pkcs12/projects/opencode/packages/app/src/pages/layout/sidebar-items.tsx`
- `/home/pkcs12/projects/opencode/packages/app/src/pages/layout/sidebar-workspace.tsx`
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
- 同時 `packages/app/src/context/global-sync/event-reducer.ts` 也已明確註記：web 不應直接相信 backend `session.diff` bus event；前端應以 explicit fetch 的 authoritative review API 為準。
- 第一階段最小修正集中在 `packages/app/src/pages/session.tsx`：
  - 移除 review panel 對 `selectedTurnMessageID` 的綁定。
  - `reviewDiffKey` 改為直接使用 `params.id`（sessionID）。
  - 開啟檔案異動視窗時，改呼叫 `sync.session.diff(id)`。
- 第二階段曾短暫使用 app-side heuristic（touched-file / content-match / tool-input attribution）來收斂 session bubble，但使用者指出這仍可能把其他 session 的異動誤算進來。
- 第三階段正式收斂成 runtime-owned contract：
  - 新增 `packages/opencode/src/project/workspace/owned-diff.ts`。
  - backend `session.diff` route 現在改成：
    - `messageID` 有值時：回傳該 user message 的 summarized diff
    - `messageID` 缺省時：回傳 authoritative session-owned dirty diff
  - authoritative session-owned dirty diff 的目前 runtime 規則為：
    - 先透過 workspace layer resolve session 所屬 execution scope
    - 若 workspace attachment 已有 session list，則只允許該 workspace 內已附著的 session 取值
    - 再以 assistant tool parts 抽出明確寫入型檔案（`write` / `edit` / `apply_patch` / `filesystem_*`）
    - 最後只保留目前 dirty diff 仍與該 session 最新 summarized diff (`after/status`) 相符的檔案
- app 端同步簡化：
  - `packages/app/src/context/sync.tsx` 不再以 `client.file.status()` 直接作為 session review/diff truth，而改成統一呼叫 `client.session.diff({ sessionID })`
  - `packages/app/src/pages/session.tsx` 與 `packages/app/src/pages/layout/sidebar-items.tsx` 不再自行做 dirty attribution heuristic，而直接消費 runtime 回傳結果
  - 先前新增於 app helper 的 session dirty attribution helper 已移除，避免重複造輪子
- 依使用者後續需求，在 `packages/app/src/pages/session/message-timeline.tsx` 的對話標題右側新增 dirty indicator bubble：
  - 數量來源現已直接來自 runtime-owned session diff count
  - 僅在 count > 0 時顯示
  - hover / focus-within 與 sidebar row bubble 保持一致互動樣式
- 最後將 title / sidebar 兩處重複的 bubble 樣式抽成共用元件 `packages/app/src/components/dirty-count-bubble.tsx`，統一 active / hover / focus / 圓角策略，避免之後再出現視覺漂移。
- 再依後續需求，在 `packages/app/src/pages/layout/sidebar-items.tsx` 的 session list row 上新增 dirty count bubble：
  - bubble 顯示在 session 標題與時間之間
  - 若該 session 已預取 message 但尚未有 dirty cache，row 會背景呼叫 `session.diff({ sessionID })` 補齊 runtime-owned count
  - 針對 active row 與 hover / focus-within 狀態，也同步提高 bubble 對比
- 再依最新需求，在 `packages/app/src/pages/layout/sidebar-workspace.tsx` 移除 webapp session list 的 `[repo]` 前綴，保留純 session title（以及 child count），因為目前 sidebar 階層已足夠表達所屬 repo / workspace。

### Validation

- 驗證指令：
  - `bun test packages/opencode/test/project/workspace-service.test.ts packages/opencode/test/project/workspace-owned-diff.test.ts`
  - `bun test --preload ./happydom.ts ./src/pages/session/helpers.test.ts` (in `packages/app`)
  - `bun turbo typecheck --filter @opencode-ai/app`
  - `bun run --cwd packages/opencode typecheck`
- 結果：passed（包含 runtime-owned session diff contract 導入後再次驗證通過）
- Architecture Sync: Updated
  - 依據：本輪已將 dirty/review ownership 從 app heuristic 收斂為 runtime-owned session diff contract，屬於 architecture boundary 變更，因此同步補強 `docs/ARCHITECTURE.md` 與對應 workspace 設計文件。
