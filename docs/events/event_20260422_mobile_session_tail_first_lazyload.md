# Event: mobile session tail-first lazyload

**Date**: 2026-04-22
**Trigger**: 使用者回報手機透過 CMS 連 daemon 時，內容累積差異大的舊 session 會因載入過慢而逾時；懷疑 session dialog lazy replay 未生效。後續又補充手機端整體使用不穩：prompt 送出後不回應、subagent 中途停止且 main agent 無知覺、以及不定時被登出。

## 需求

- 在新的 frontend 連 daemon/CMS 時，session 開啟流程應改為 **tail first, lazy load history later**。
- 目標是避免長 session 在手機網路 + CMS gateway + per-user daemon 路徑上因整包 history hydration 而逾時。

## 範圍

### IN

- frontend 開啟 session 時的 hydration 順序
- CMS/gateway → user-daemon 的 session message 代理參數
- session message API 是否支援真正的 tail-first / cursor append
- 既有 `frontend_session_lazyload` flag 與 tweaks bootstrap 是否真的生效
- mobile/CMS 路徑下的 attach / catch-up / session continuity 驗證邊界

### OUT

- provider / model / SSE schema 改寫
- AI SDK delta merge 演算法重做
- 舊 session 資料壓縮/搬遷
- mobile auth/logout policy 本體重寫
- orchestrator/subagent runtime contract 重寫（除非證據顯示本次 attach/reconnect 問題直接導致）

## 證據 / Checkpoints

1. `packages/app/src/pages/session.tsx` 進入 session 頁面時會呼 `sync.session.sync(id, { force: true })`。
2. `packages/app/src/context/sync.tsx` 目前 `sync()` 會並行抓 `session.get` 與 `session.messages`；冷啟動仍以 `limit` 模式整包 hydrate `MessageV2.WithParts[]`。
3. `packages/app/src/context/sync.tsx` 的 `history.loadMore()` 是把 `limit` 變大後再次重抓，不是 cursor append。
4. `packages/opencode/src/server/routes/session.ts` 已支援 `GET /session/:id/message?since=...` incremental tail fetch，但 CMS/user-daemon proxy path 只傳 `limit`，遺失 `since`。
5. `packages/opencode/src/server/user-daemon/manager.ts` per-user daemon request timeout 預設為 5000ms；在手機網路與 CMS proxy 下，整包 history hydration 很容易踩 timeout。
6. `packages/app/src/context/frontend-tweaks.ts` 定義了 `ensureFrontendTweaksLoaded()` 與 `frontend_session_lazyload` flag，但目前未在 `packages/app/src/app.tsx` 找到 bootstrap 呼叫點；lazyload 可能長期停留在預設 `0`。
7. 使用者另回報 mobile/CMS 整體不穩：
   - prompt 發出後不回應
   - subagent 中途停止，main agent 無知覺
   - 不定時被登出
     這些症狀目前尚未有程式證據連到同一根因，但都屬於 mobile/CMS 路徑必須驗證的相鄰 reliability surfaces。

## 設計判讀

- 現況不是「lazy replay 失效了一小段」，而是 **session open 協定本身仍偏向 full hydration first**。
- 既有 lazyload 主要停留在：
  - render 層只先顯示最後幾個 turn
  - force-resync path 有 `since` incremental fetch
- 但真正的網路/儲存 attach protocol 尚未做到：
  - open 時先拿 tail slice
  - 上滑時再 cursor-based append older history
  - CMS proxy 完整保留 incremental/cursor 參數
- 使用者新補充的「prompt 不回應 / subagent 斷線 / 被登出」不能直接被假設都是 lazyload 問題；目前較合理的判讀是：
  - **可能相關**：attach/reconnect/timeout 失敗讓 mobile session 看起來像 prompt 無回應
  - **可能相鄰但獨立**：workflow continuity、session auth persistence、SSE/rebind/reconnect
    因此本次 plan 要把它們納入驗證與 stop-gate，而不是草率併成同一個 root cause。

## 決策

- **DD-1** 這不是單純 flag 開關問題；即使補上 frontend tweaks bootstrap，也只能恢復 meta-driven page sizing，還不等於真正的 tail-first attach。
- **DD-2** 新 frontend 連 daemon 的 session open contract 應改為：`session.get/meta` → `tail page` → render → background/scroll-triggered older history fetch。
- **DD-3** `history.loadMore()` 應從「擴大 limit 全量重抓」改為 cursor/before-based append older messages。
- **DD-4** CMS/user-daemon path 不可丟失 `since`；若導入 cursor/before，proxy 也必須完整透傳，否則手機/CMS 路徑仍會退化。
- **DD-5** 這項需求已超出既有 `specs/frontend-session-lazyload/` 的「只靠 meta + page size + render-side lazyload」範圍；後續應以 `revise` 或 `extend` 方式重開該 spec，而不是當作微調。
- **DD-6** mobile 不穩定症狀先作為本 spec 的 **validation companions**：實作 tail-first attach 時必須一併驗證「prompt round-trip / subagent continuity / session auth continuity」沒有被 attach timeout/reconnect 路徑破壞。若仍存在，必須拆出獨立 reliability spec，不可硬塞在 lazyload 實作裡。

## 建議後續任務

1. 補 `ensureFrontendTweaksLoaded()` 的 app bootstrap，先確認既有 lazyload flag 真有生效。
2. 修正 `callSessionMessages()` 代理介面，完整透傳 `since`。
3. 設計 `session.messages` 的 `beforeMessageID` / `cursor` older-history API，避免 `loadMore()` 全量重抓。
4. 將 `sync.session.sync()` 重構為 open-session attach protocol：tail-first hydrate，older history lazy append。
5. 重新同步 `specs/frontend-session-lazyload/`（目前 tasks 與 `.state.json=verified` 顯示不一致，需要先收斂 spec 真實狀態）。
6. 在 mobile/CMS 驗證腳本/手動驗證中加入：prompt submit→reply、subagent completion relay、登入持久性；若失敗且與 attach timeout 無直接證據連結，另開 reliability plan。

## Validation

- 本回合只做架構與程式路徑調查，未改 code、未跑測試。
- `specs/architecture.md`: Architecture Sync: Verified (No doc changes)。依據：本次僅新增事件紀錄與設計判讀，尚未變更模組邊界或實作。
