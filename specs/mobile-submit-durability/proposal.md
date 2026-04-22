# Proposal: mobile-submit-durability

> **SUPERSEDED by `frontend-session-lazyload` revise (2026-04-22)**
>
> 初版 RCA 誤判根因在 client-side POST durability（提出 3s ACK + 靜默 retry + IndexedDB outbox 等 client-side 補強）。
> 同日再查 `gateway journal` vs `daemon structured log` 發現：gateway 在 19:31–19:35 實際收到 7× POST `/prompt_async`，daemon 卻 0× 看到 `prompt_async inbound`。
> 斷點在 **gateway → daemon 的 splice proxy 反壓**，根因是 **daemon event-loop 被 (a) SSE reconnect 全量 replay 1000-event ring buffer 握手、(b) session.messages full hydration 餓死**。
>
> Client retry 只是補破網；修好 G9 (SSE bounded replay) + G10 (messages cursor pagination) 後，此 spec 所列症狀自動消失。
> 保留本 proposal 作 audit trail。若 G9+G10 上線後仍有殘留 true-OS-freeze 情境，再 reopen。

## Why

手機端使用者透過 CMS gateway 發送 session prompt（POST `/api/v2/session/:id/prompt_async`）時，經常發生「composer 清空 + optimistic message 顯示 + 但 server 端從未收到」的靜默失敗。2026-04-22 實地重現：同一 session 手機連發 15+ 則 prompt，daemon 端 `prompt_async inbound` log **0 筆**，但使用者看不到任何 toast、也無法辨識失敗。現行 submit path 是 fire-and-forget（`void send().catch()`），沒有 ACK 驗證、沒有 timeout、沒有 retry、沒有持久化 — 任何 iOS/Android tab freeze 或行動網路切換都能靜默吞掉 fetch。

觀察重點：同期 HTTP GET（`/autonomous/health` 輪詢、`/session/top`）完全正常運作，只有 POST `/prompt_async` 無聲消失。強烈指向 mobile runtime 在 POST body upload 階段被 OS 凍結或 cancel，且 Promise 未被 reject 回到 JS 層。

## Original Requirement Wording (Baseline)

- "要求太多。你應該從程式面幫我做重構推演。"
- "應該是送不出要自動靜默retry吧？現在是丟出後就不理嗎？"
- "好。那這個3秒就是送出後確認fail的期限。我要求訊息送出後要能確認有被收到。"

## Requirement Revision History

- 2026-04-22: initial draft — 從 2026-04-22 mobile session RCA 事件整理
  - 核心契約：**POST 送出後 3s 內必須拿到 server ACK，否則視為失敗並自動靜默 retry**

## Effective Requirement Description

1. **ACK 契約**：client 發出 POST `/prompt_async` 後，必須在 3 秒內收到 HTTP 2xx（204 Accepted 為目前路由語意）。逾時視為未送達。
2. **靜默 retry**：未送達時，client 自動重送；使用者不需手動操作。retry 策略採指數退避（初始延遲可調），有上限。
3. **Idempotency**：retry 以同一 `messageID` 重送；server 必須辨識同 messageID 為同一 prompt，不可重跑 runloop。
4. **失敗終局化**：達到 retry 上限仍失敗時，toast + 還原 composer 內容，讓使用者知道並可手動重送。
5. **觀察性**：submit 的每一個 attempt（start / ack / timeout / retry / give-up）都要有 telemetry，能在 browser console 與 daemon log 對照。

## Scope

### IN

- `packages/app/src/components/prompt-input/submit.ts` 的 send 路徑重構
- 新增 client-side submit wrapper（timeout + retry + telemetry）
- server 端 `POST /session/:id/prompt_async` 的 messageID 去重邏輯
- `packages/opencode/src/session/prompt-runtime.ts` 對 replay submit 的語意
- submit 與 SSE reconnect 的協同（避免 reply 走死 channel）
- 修正 `pending` Map 單槽被第二次 submit 蓋掉的副 bug
- 新增 `visibilitychange=visible` 事件的 in-flight submit 補送
- 對 CMS gateway proxy path 的 ACK 行為驗證（`UserDaemonManager.callSessionPromptAsync`）

### OUT

- IndexedDB outbox 的跨 tab-reload 持久化（v2；v1 只處理 session alive 範圍內的 durability）
- Service Worker / Background Sync（iOS Safari 不支援）
- CMS gateway 本體的超時或連線保持參數調整
- SSE 傳輸層本身的重構（已由 `session-ui-freshness` living spec 管理）
- 其它 session route 的 idempotency（`command`, `shell`, `abort` 等）
- Web Push / 離線通知

## Non-Goals

- **不追求「手機 100% 永不丟訊息」**：若使用者關 tab / 殺 browser process，允許丟失
- **不追求跨裝置同步 pending outbox**：A 手機上發的 pending 不會出現在 B 桌機
- **不重新設計 sync/SSE 層**：完全尊重 `session-ui-freshness` 已有 contract
- **不處理「prompt 送到但 server 拒絕」的語意** (BusyError 等）：那是另一條 path

## Constraints

- **3 秒 ACK 硬門檻**：使用者明確指定；改動此值需走 `amend` 修訂
- **messageID 是既有欄位**：[submit.ts:414](../../packages/app/src/components/prompt-input/submit.ts#L414) 已產生並傳給 server，spec 不新增識別碼
- **不得破壞 `session-ui-freshness` living spec 的 contract**：`lastEventAt` / `forceSseReconnect` / `receivedAt` 行為保持
- **不得破壞既有 AGENTS.md 第一條「禁止靜默 fallback」**：本案的「靜默 retry」是 LLM↔tool 協商層級的 self-heal（類似 `feedback_lazy_loader_schema_miss`），不是用備援掩蓋錯誤；每一次 retry 仍有 telemetry，達上限仍會報錯
- **CMS proxy 路徑必須同樣保障 ACK**：gateway → per-user daemon 的 `callSessionPromptAsync` 不能在 proxy 層黑洞化失敗
- **server dedupe 必須 O(1)**：用記憶體 map keyed by `{sessionID, messageID}`，不要寫盤
- **retry 上限 ≤ 5 次**：避免手機在無網環境永遠轉圈

## What Changes

- **Client**：submit.ts 的 `send()` 改成「attempt loop + 3s AbortController timeout + 指數退避 + telemetry」
- **Client**：`pending` Map 從 `session.id` 單槽 → `messageID` 多槽，避免第二 submit 蓋第一
- **Client**：新增 `visibilitychange` listener，回前景時掃描 in-flight pending 進行補送
- **Client**：`clearInput()` 時機從 optimistic 加入時 → 延後到**第一次成功 ACK 後**
- **Server**：`POST /session/:id/prompt_async` 讀取 body.messageID，若已見過則直接回 204（或 202 + 原 runID），不重跑
- **Server**：`prompt-runtime.start()` 的 BusyError 語意區分 — 同 messageID 視為 replay 回傳現有 runID；不同 messageID 才 Busy
- **Gateway**：`UserDaemonManager.callSessionPromptAsync` 的 timeout 配合 ACK 行為，失敗類型要能被 client 區分

## Capabilities

### New Capabilities

- **submit attempt telemetry**：console log 每次 attempt 的 start/ack/timeout/retry/give-up，與 daemon `prompt_async inbound` 以 messageID 對照
- **server-side messageID dedupe**：同一 prompt 多次 POST 只會執行一次 runloop
- **foreground recovery**：回前景時自動補送凍結期間的 pending submit

### Modified Capabilities

- **submit send path**：從 fire-and-forget 改為「保證至少 ACK 一次」
- **pending map**：從 session-singleton 改為 messageID-keyed 多槽
- **clearInput timing**：從 optimistic 即清 → ACK 後才清
- **BusyError semantics**：同 messageID 不再視為 Busy

## Impact

- **影響代碼**：
  - `packages/app/src/components/prompt-input/submit.ts`（主要）
  - `packages/opencode/src/server/routes/session.ts`（prompt_async handler）
  - `packages/opencode/src/session/prompt-runtime.ts`（start 語意）
  - `packages/opencode/src/server/user-daemon/manager.ts`（proxy timeout 協調）
- **影響 API**：`POST /session/:id/prompt_async` 行為語意擴充（向後相容：messageID 首次 = 維持原行為）
- **影響 docs**：`specs/architecture.md` 若涉及 submit contract 需同步；`session-ui-freshness` spec 可能需加 cross-reference
- **影響使用者**：手機端主觀體驗顯著改善；桌機端行為應無感（ACK 幾 ms 內拿到，retry 路徑不會觸發）
- **影響 operator**：新增 log prefix `[submit]` / `[prompt_async]` / `[dedupe]` 方便排障
