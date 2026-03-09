# Event: existing session reload black screen RCA

Date: 2026-03-09
Status: Done

## 需求

- 修復 webapp 直接 reload 到 `/{dir}/session/{sessionID}` 時的黑畫面問題。
- 採最小修復：只補 existing-session route 的初次 hydrate 與 loading fallback。
- 不再碰 handover / controller / panel fallback / layout autoload。

## 範圍

### IN

- `/home/pkcs12/projects/opencode/packages/app/src/pages/session.tsx`
- `/home/pkcs12/projects/opencode/docs/events/event_20260309_existing_session_reload_black_screen_rca.md`

### OUT

- 不修改 server API contract
- 不恢復 mobile 全域 resume sync
- 不修改 handover / controller 模型
- 不修改 layout project/session autoload 策略

## 任務清單

- [x] 盤點 baseline reload 路徑與 render gate
- [x] 補 existing-session initial hydrate
- [x] 補 loading fallback
- [x] 驗證並更新紀錄
- [x] 補 scoped debug trace 以確認實際卡點
- [x] 補 frontend → debug.log beacon 與 server direct checkpoint

## Debug Checkpoints

### Baseline

- 使用者提供的 reload URL 為 `/{dir}/session/{sessionID}`，代表 `params.id` 本來就存在。
- `packages/app/src/context/sync.tsx` 的 `session.sync(sessionID)` 目前只在顯式呼叫或 resume 類事件下觸發；existing session route page mount 時沒有自動 initial hydrate。
- `packages/app/src/pages/session.tsx` 中：
  - `messagesReady()` 以 `sync.data.message[id] !== undefined` 判斷是否已 hydrate
  - `activeMessage()` 依賴已載入的 user messages
  - 主內容區在 `params.id` 路徑下只有 `activeMessage()` 成立才 render `MessageTimeline`
- 因此 reload 到既有 session 時，若 messages 尚未載入：
  - `messagesReady()` = false
  - `activeMessage()` = undefined
  - 主內容區無 fallback，體感即為黑畫面
- 使用者送出新訊息後，optimistic message 進入 store，`activeMessage()` 才成立，所以畫面恢復；這與症狀一致。

### Execution

- 在 `packages/app/src/pages/session.tsx` 補上 existing-session route 的一次性初次 hydrate：
  - 條件：`params.id` 存在，但 `info()` 或 `messagesReady()` 尚未就緒
  - 行為：在 `requestIdleCallback`（無則退回 `setTimeout(200)`）時執行一次 `sync.session.sync(sessionID, { force: true })`
  - 目的：只補 page reload 進既有 session 的首次載入缺口，不恢復先前會干擾 mobile 互動的全域 resume sync
- 將 `params.id` 路徑下的主內容 render gate 改為：
  - `messagesReady() && activeMessage()` 時才 render `MessageTimeline`
  - 否則顯示 `session.messages.loading` fallback
- 結果：existing session route reload 時，畫面不再直接黑屏，而是先顯示 loading，同時補一次安全 hydrate。
- 因使用者回報問題仍持續，本輪再補 trace，避免繼續盲修：
  - 前端 `packages/app/src/context/sync.tsx`
    - `session.sync:start/get/done/error`
    - `loadMessages:start/success/error/done`
  - 前端 `packages/app/src/pages/session.tsx`
    - `session-page:state`
    - `session-page:hydrate`
  - 後端 `packages/opencode/src/server/routes/session.ts`
    - `session.get request/response`
    - `session.messages request/response`
- 後端 trace 會寫入既有 debug logger；前端 trace 走 browser console。
- 進一步比對「reload 卡住」與「手動從 session list 點一下就恢復」兩條程式路徑後，發現關鍵差異：
  - 成功路徑 `layout.tsx` 的 `prefetchMessages(...)` 使用 `globalSDK.client.session.messages({ directory, sessionID, ... })`
  - 失敗路徑 `context/sync.tsx` 的 `session.sync(...)` 原本使用：
    - `client.session.get({ sessionID })`
    - `client.session.messages({ sessionID, limit })`
    - **都沒有顯式帶 `directory`**
- 再對照 SDK 型別 `packages/sdk/js/src/v2/gen/types.gen.ts`：
  - `SessionGetData.query.directory?: string`
  - `SessionMessagesData.query.directory?: string`
  - 證明這兩條 API 都支援顯式 `directory`
- 因此本輪將 `sync.session.sync()` 補為顯式帶 `directory`：
  - `client.session.get({ directory, sessionID })`
  - `client.session.messages({ directory: sdk.directory, sessionID, limit })`
- RCA 假設：reload 進 existing session route 時，僅靠 sdk client 預設 header 的 directory 綁定不夠穩；而 sidebar/prefetch 路徑因顯式帶 `directory`，所以手動點一下就能恢復。
- 第二輪 debug 進一步聚焦 `session_status`：
  - 前端 `SessionTurn` 補 `session-turn:status`
    - `statusType`
    - `working`
    - `assistantCount`
    - `assistantPartCounts`
  - 前端 `prompt-input` watchdog 補 `prompt-input:status-poll`
    - `currentType`
    - `nextType`
  - 後端 `session.status` route 補 `session.status request/response`
    - `count`
    - `active` session list
- 目的：驗證是不是 reload 後 `session_status` 一直卡成非 idle，導致畫面上的 loading 實際來自 `SessionTurn` 內部 spinner，而不是 message hydrate 本身。
- 因 `log.debug(...)` 受 logger level 影響，這輪改以兩條可落盤路徑補強：
  - server route 直接呼叫 `debugCheckpoint(...)`，繞過 `INFO` level 對 `log.debug` 的抑制
  - webapp 新增 `POST /api/v2/experimental/debug-beacon`，把前端 checkpoint（reload hydrate / render gate / turn status / status poll）直接送進 `debug.log`
- beacon 會帶：
  - `directory`
  - `sessionID`
  - `messageID`（若有）
  - 對應 checkpoint payload（如 `messagesReady` / `visibleUserMessages` / `statusType` / `nextType`）
- 前端 beacon 採短時間去重，避免 reload 期間重複 effect 將 `debug.log` 洗爆。

### Validation

- `bun run typecheck`（workdir: `/home/pkcs12/projects/opencode/packages/app`）✅
- `bun run typecheck`（workdir: `/home/pkcs12/projects/opencode`）✅
- `./webctl.sh dev-refresh` ✅（已啟用 `/etc/opencode/opencode.cfg` 的 `OPENCODE_DEBUG_LOG="1"`，並重啟 active dev web runtime）
- 使用者手動重啟 web 後重新 reload 同一 existing-session URL，黑屏問題已解除 ✅
- Architecture Sync: Verified (No doc changes)
  - 依據：本輪僅補 existing session route reload 的前端 hydrate/fallback 行為，未改變 current-state architecture boundary 或 runtime topology。

## 關鍵發現（本輪 RCA）

- 這次已成功把 reload 過程寫進 `~/.local/share/opencode/log/debug.log`。
- 直接 reload `/{dir}/session/{sessionID}` 時：
  - `session.get` 成功，directory 正確：`/home/pkcs12/projects/opencode`
  - `session.messages` 成功，訊息數量正確（例：`count: 372`）
  - `session-page:state` 顯示 `hasInfo: true`、`messagesReady: true`
  - `session-page:render-gate` 顯示 `visibleUserMessages > 0`
- 代表 **direct reload 路徑本身並沒有卡在 session hydrate / messages API / render gate**。
- `session.status` 在 reload 初期回傳 `count: 0, active: []`，且 `prompt-input:status-poll` 顯示：
  - `currentType: "busy"`
  - `nextType: "idle"`
- 代表前端 store 的確短暫帶著 stale `busy`，但 server authoritative status 很快就是 idle；因此 **不是後端真的一直 busy**。
- 結論：
  - 先前假設的「因為 `session.status` 一直 stuck 非 idle 導致整頁卡住」已被證據否定。
  - 目前更可能是 **某個仍使用 `session.messages.loading` 字串的前端局部元件** 在 reload 後沒有隨資料完成而正常切換。
  - 已知候選只剩：
    - `packages/app/src/pages/session/components/session-turn.tsx`
    - `packages/app/src/pages/layout/sidebar-items.tsx`
    - （page-level fallback 已被 log 證據排除）
- 補查後發現一個重要事實：
  - `packages/app/src/pages/session/message-timeline.tsx` 實際 import 的 `SessionTurn` 來自 `@opencode-ai/ui/session-turn`
  - **不是** `packages/app/src/pages/session/components/session-turn.tsx`
- 因此 app local `session-turn.tsx` 的 debug patch 屬於 **未命中實際 render path**；後續 debug 必須以 `packages/ui/src/components/session-turn.tsx` 與 `session.tsx` 真正 fallback render 點為主。
- 為了驗證使用者看到的「正在載入訊息...」是否真的來自 page-level fallback，本輪再對 `session.tsx` 的 fallback 實際 render 點補 `session-page:loading-fallback-render` beacon。
- 新一輪實證顯示：
  - `session-page:timeline-input` 出現
  - `message-timeline:render-state` 出現
  - `message-timeline:turn-mounted` 也出現
  - 代表 `MessageTimeline` 本體與 `<For each={renderedUserMessages}>` turn wrapper **都有成功 mount**。
- 因此先前「可能連 `MessageTimeline` / turn wrapper 都沒進去」的假設已被排除；真正的卡點已縮小到：
  - `packages/ui/src/components/session-turn.tsx` 內部
  - 或其子元件的可見性 / render branch / CSS 顯示問題
- 同時發現 `packages/ui/src/components/session-turn.tsx` 內建的 debug beacon 原本直接用裸 `fetch("/api/v2/experimental/debug-beacon")`：
  - 沒有 `credentials: "include"`
  - 沒有 `x-opencode-csrf`
- 由於本 repo 的 web mutation 路徑受 auth/CSRF 保護，這代表：
  - `SessionTurn` 先前**未必沒有 render**
  - 更可能只是 beacon request 被 server 拒絕，導致 `debug.log` 看不到 `session-turn:render-state`
- 本輪已修正 `packages/ui/src/components/session-turn.tsx` 的 beacon request：
  - 補 `credentials: "include"`
  - 補 `x-opencode-csrf`
- 另有使用者回報新症狀：載入 session 後，往上翻不到更早對話，畫面起點像被截在本 session 頂部。
  - 目前高度懷疑與 `session.tsx` 的 `turnStart` / lazy backfill (`requestIdleCallback`) 有關
  - 但在未取得修正後的 `session-turn:render-state` 前，暫不直接下結論
  - 後續需分開驗證：
    1. 黑屏是否來自 `SessionTurn` 內部 render / visibility
    2. 上翻歷史缺失是否來自 `turnStart` backfill starvation
- 取得 `session-turn:render-state` 後，發現真正更關鍵的證據：
  - full reload 後先出現 `session-page:loading-fallback-render`（`messagesReady: false`, `hasInfo: true`）
  - **但沒有任何** `session-page:hydrate` / `session.sync:start` / `loadMessages:start` checkpoint
  - 之後頁面卻因新的 prompt / optimistic state，變成 `totalMessages: 1`
- 這表示不是 `sync.session.sync()` 失敗，而是 **它根本沒有在 initial mount 時被觸發**。
- 根因定位：
  - `packages/app/src/pages/session.tsx` 的 initial hydrate effect 使用
    - `createEffect(on(() => [params.id, !!info(), messagesReady()], ... , { defer: true }))`
  - `defer: true` 會跳過初次執行
  - 在 direct reload 場景下，常見初始狀態剛好就是：
    - `params.id` 已存在
    - `info() === true`
    - `messagesReady() === false`
  - 因為 callback 沒有在 mount 當下執行，後面若沒有其他依賴變化，就不會補打 `sync.session.sync(id, { force: true })`
  - 這正好解釋：
    - reload 後先黑屏 / loading fallback
    - 沒有真正 hydrate 既有訊息
    - 一旦使用者送出新訊息，只剩 optimistic/current turn 可見，看起來像歷史被截斷
- 本輪最小修復：
  - 移除該 hydrate effect 的 `{ defer: true }`
  - 保留既有 `initialHydratedSessionID` guard，避免重複 force sync
  - 讓 existing-session direct reload 在 mount 當下就能觸發一次 `sync.session.sync(...)`
- 收尾階段已將本輪新增的 debug-log instrumentation 先行停用（保留程式碼、以 flag/no-op 方式 mark out），避免日常操作持續寫入 debug.log；未來若需再次做 RCA，可直接重新開啟。
