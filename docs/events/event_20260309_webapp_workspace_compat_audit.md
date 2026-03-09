# Event: Webapp workspace compatibility audit and repair

Date: 2026-03-09
Status: Done

## 需求

- 全面盤查 webapp 在 `new-workspace` 併入後，所有需要依 workspace 重新設計或修正的區域。
- 逐一實作修復，避免只修單一 startup crash。
- 每輪修復後自動進行 build / 測試 / browser 驗證；若失敗則繼續遞回修復，直到 webapp 可正常上線。

## 範圍

### IN

- `/home/pkcs12/projects/opencode/packages/app/**`
- `/home/pkcs12/projects/opencode/packages/util/src/workspace.ts`
- 必要時與 webapp workspace adapter / runtime API 對接的共用模組
- 對應測試與驗證腳本

### OUT

- 不改 preview runtime 設計範圍
- 不改 TUI 專屬互動邏輯，除非 webapp 共用模組修復必須同步
- 不做與 workspace 無關的視覺優化

## 任務清單

- [x] 盤點 webapp workspace 受影響模組與路徑
- [x] 對每個受影響區域判斷：可沿用 / 需調整 / 需重設計
- [x] 逐項修復 runtime 與 UI state mismatch
- [x] 自動重跑 build / test / browser 驗證直到穩定
- [x] 驗證 Architecture Sync

## Debug Checkpoints

### Baseline

- `new-workspace` 開發時主要驗證 TUI，webapp coverage 不足。
- 已出現至少兩類 webapp 回歸：
  - `current()[0]` child tuple 未就緒造成 startup crash
  - browser bundle 直接吃到 `node:path` 導致 `normalize is not a function`

### Execution

- 先前已修正 `packages/app/src/context/sync.tsx` startup guard，避免 `current()[0]` 尚未可用時直接 crash。
- 針對 browser runtime 再次定位到 `packages/util/src/workspace.ts` 直接使用 `node:path`；已改為 browser-safe 的字串式 workspace path normalization，避免 bundle 在瀏覽器中呼叫不存在的 `normalize()`。
- 盤查後確認 webapp 受 workspace 影響的高風險區域至少包含：
  - layout/sidebar 的 workspace/project 比對與排序鍵
  - prompt/comments/terminal/file-view 的 workspace-scoped cache key
  - session/header/file picker 等以 worktree/sandbox 直接比對目錄的 UI 邏輯
  - server project open/close/move 去重邏輯
- 已先做第一輪基礎修復：
  - `packages/app/src/pages/layout/helpers.ts`
    - `workspaceKey` 改為共用 canonical normalization
    - `syncWorkspaceOrder` 改為以 canonical key 去重/合併
  - `packages/app/src/context/prompt.tsx`
  - `packages/app/src/context/comments.tsx`
  - `packages/app/src/context/terminal.tsx`
  - `packages/app/src/context/file.tsx`
    - 將 workspace-scoped cache key 改為直接使用 canonical route directory，避免等待 async workspace aggregate 後重綁 key，造成草稿/評論/terminal/file-view 狀態切換或遺失
  - `packages/app/src/pages/layout.tsx`
  - `packages/app/src/pages/layout/sidebar-project-helpers.ts`
  - `packages/app/src/components/session/session-header.tsx`
  - `packages/app/src/components/dialog-select-file.tsx`
  - `packages/app/src/context/server.tsx`
  - `packages/app/src/pages/session.tsx`
    - 將多處 `worktree === directory` / `sandboxes.includes(directory)` / raw path compare 改為 canonical workspace key compare
- UI 額外調整：
  - `packages/app/src/pages/error.tsx` 已移除錯誤頁中的 Discord 回報提示文字。
- 第二輪補強：
  - `pages/layout.tsx` 的 workspace expanded / drag reorder / route-driven auto-expand 改為使用 canonical workspace key
  - `pages/layout/sidebar-project-helpers.ts`、`context/server.tsx`、`pages/session.tsx` 補 canonical compare，避免 raw path alias 導致 open/close/select mismatch
- 第三輪 browser-only 補強：
  - `packages/util/src/workspace.ts` 的 `createWorkspaceId(...)` 原本使用 `Buffer(...).toString("base64url")`
  - 這在 web bundle 中會直接觸發 `ReferenceError: Buffer is not defined`
  - 已改為共用 `base64Encode(...)`，移除 browser 對 Node `Buffer` 的依賴
- 第四輪 follow-up 補強：
  - review 發現 cache scope 從 `store.workspace?.directory` 改成純 route directory 後，若 server 以 `X-Opencode-Resolved-Directory` 修正 alias/stale path，route 本身仍可能停留在舊 alias，造成 prompt/comments/terminal/file-view cache 分桶錯位
  - 已在 `packages/app/src/pages/directory-layout.tsx` 新增 canonical route replace：當 `sync.directory` 與當前 decoded route directory 不同時，自動以 resolved canonical directory 取代目前 URL，保留原本 nested route / query / hash
  - 已在 `packages/app/src/context/sync.tsx` 補 dev-only warning；若 `globalSync.child(...)` 意外缺席，不再完全靜默退回 fallback child，方便後續偵測 bootstrap 異常
- 以目前盤查結果，已處理會直接影響 webapp 啟動、workspace sidebar/session 顯示、workspace-scoped cache、以及主要 workspace compare 的高風險路徑。

### Validation

- `bun run --cwd packages/app typecheck` ✅
- `bun run --cwd packages/app test:unit -- src/context/prompt.test.ts src/context/comments.test.ts src/context/terminal.test.ts src/context/file/view-cache.test.ts src/context/global-sync/workspace-adapter.test.ts src/pages/layout/helpers.test.ts src/pages/layout/sidebar-project-helpers.test.ts src/components/prompt-input/submit.test.ts` ✅
- `bun run --cwd packages/app test:unit -- src/pages/directory-layout.test.ts` ✅
- `bun run --cwd packages/app test:unit` ✅
- `bun run build --single` ✅
- `./webctl.sh dev-refresh` ✅
- Browser smoke (`https://crm.sob.com.tw`) ✅
  - 首頁非錯誤頁
  - Discord 提示字句已消失
  - 無 `pageerror`
  - request failure probe 未重現新的 blocking API 錯誤
- 針對使用者回報的 `ReferenceError: Buffer is not defined` 再驗證 ✅
  - rebuild + refresh 後 browser smoke 未再出現 Buffer 錯誤
  - `HAS_BUFFER_ERROR: False`
- 已觀察到一筆非阻塞 console `502` 資源錯誤，但未重現為 app startup failure，也未導致錯誤頁；目前不作為阻塞上線條件
- alias/stale directory → resolved directory route healing 已補 canonical replace；可避免 workspace-scoped cache 因舊 URL 殘留而分裂
- Architecture Sync: Verified (No doc changes)
  - 本次為 webapp workspace 相容層與 UI state 修復，未改變 architecture boundary。
- 結論：目前 webapp 已恢復可正常啟動，workspace 相關高風險 web regressions 已完成第一輪全面修補，且 build / full app unit tests / browser smoke 皆通過，可作為目前上線基線。
