# Event: Codex incremental delta RCA

Date: 2026-03-30
Status: Done

## 1. 需求

- 針對「Codex incremental delta 一直沒測通，且 context 消耗巨大」做 RCA。
- 本輪只做 evidence gathering / causal chain 收斂，不直接修改 runtime。

## 2. 範圍

### IN

- `/home/pkcs12/projects/opencode/packages/opencode/src/session/llm.ts`
- `/home/pkcs12/projects/opencode/packages/opencode/src/plugin/codex.ts`
- `/home/pkcs12/projects/opencode/packages/opencode/src/plugin/codex-websocket.ts`
- `/home/pkcs12/projects/opencode/packages/opencode/src/session/processor.ts`
- `/home/pkcs12/projects/opencode/packages/opencode/src/session/index.ts`
- `/home/pkcs12/projects/opencode/packages/opencode/src/session/message-v2.ts`
- `/home/pkcs12/projects/opencode/packages/opencode/src/server/routes/global.ts`
- `/home/pkcs12/projects/opencode/packages/app/src/context/global-sdk.tsx`
- `/home/pkcs12/projects/opencode/packages/app/src/context/global-sync/event-reducer.ts`
- `/home/pkcs12/projects/opencode/packages/opencode/src/cli/cmd/tui/context/sync.tsx`
- `/home/pkcs12/projects/opencode/packages/opencode/src/tool/task.ts`
- `/home/pkcs12/projects/opencode/specs/architecture.md`
- `/home/pkcs12/projects/opencode/docs/events/event_20260227_batch3_phaseE3A_refactor_port.md`
- `/home/pkcs12/projects/opencode/docs/events/event_20260314_webapp_cpu_spike_crash.md`

### OUT

- 不修改 Codex provider / session / SSE / reducer runtime
- 不直接實作 delta transport 修補
- 不調整 fallback / retry / provider policy

## 3. 任務清單

- [x] 讀取 architecture 與既有事件，建立 incremental delta RCA 基線
- [x] 追 provider-side delta 與 session/output 熱路徑
- [x] 檢查 bus / SSE / web reducer / TUI sync 的放大鏈
- [x] 收斂根因、信心排序與驗證點

## 4. Conversation Highlights

- 使用者指出 Codex incremental delta 機制長期沒有真正測通，且 context 消耗很大。
- 研究重點從「provider 是否有 delta」擴大為「delta 是否在 runtime 內被保留下來」。
- 最終收斂出 provider request 邊界與 runtime output 邊界是兩件不同的事：前者部分成立，後者幾乎完全退化成 full-part/full-event 流。

## 5. Debug Checkpoints

### Baseline

- repo 已有 Codex `previousResponseId` / `previous_response_id` 路徑，代表 provider 端確實試圖做增量請求。
- repo 也已有 stale delta guard 歷史修補，但需要確認這是否仍命中目前熱路徑。
- architecture 與既有事件已明確指出 Bus -> SSE -> frontend reconcile 的 cascade 風險。

### Instrumentation Plan

- 追 `session/llm.ts`，確認 request-side incremental delta 實際落點。
- 追 `processor.ts` / `session/index.ts`，確認 provider chunk 進 session 後是否被退化為 full part update。
- 追 `global.ts`、web reducer、TUI sync，確認 event payload 與 consumer reconcile 是否仍為 full snapshot。
- 追 `tool/task.ts`，確認 subagent bridge 是否再把 `message.part.updated` 放大一次。

### Execution

- 確認 `session/llm.ts` 會在 hash match 且有先前 response id 時設定 provider options 的 `previousResponseId`。
- 確認 `plugin/codex.ts` 與 `plugin/codex-websocket.ts` 會在有 `previous_response_id` 時裁掉 request body 的 `input` 前綴。
- 同時確認 `session/llm.ts` 仍先在本地建立完整 `streamMessages` / `finalMessages`，因此 provider trim 前本地 prompt 組裝成本依然存在。
- 確認 `processor.ts` 對每個 `text-delta` 都先 append 到 growing `part.text`，再呼叫 `Session.updatePart({ part, delta })`。
- 確認 `session/index.ts` 的 `updatePart()` 會 `Storage.write(part)` 並 `Bus.publish(message.part.updated, { part, delta })`，runtime event contract 是「full part + optional delta」，不是純 delta transport。
- 確認 `server/routes/global.ts` 會對整個 event 做 `JSON.stringify(event)` 並送出 SSE，因此 growing `part.text` 會在每個 chunk 被重送。
- 確認 Web 只在 `global-sdk.tsx` 做 frame-level coalescing，但 `event-reducer.ts` flush 後仍以 full `part` reconcile。
- 確認 TUI `context/sync.tsx` 對每個 `message.part.updated` 都做 `Binary.search` + reconcile/splice，沒有 web 那層前門 coalescing。
- 確認 `tool/task.ts` 會把 child session 的 `message.part.updated` 再 publish 回 parent/global bus，形成額外 fanout。
- repo-wide traced 結果未發現目前仍在用的 `message.part.delta` emitter；舊 guard 幾乎與現行熱路徑脫節。

### Root Cause

高信心根因是 **incremental delta 只在 provider request 邊界部分成立，但進入 session/runtime/UI 後完全退化成 full snapshot 流**：

1. **Request-side delta 只減少上游 transport，不減少本地 prompt 組裝成本**
   - `session/llm.ts` 仍先建立完整 `streamMessages` / `finalMessages`。
   - provider middleware/plugin trim 發生在較後面，因此「巨大 context」的本地組裝/normalize 成本仍然照付。

2. **Output-side delta 一進 session 就被 re-expand 成 full part**
   - `processor.ts` 對每個 chunk 都是 `currentText.text += value.text`。
   - 後續 `updatePart()` 寫入與發布的是完整 growing `part`，`delta` 只是附帶欄位。

3. **SSE 與 consumer 仍走 full-event/full-part hot path，形成近似 O(n^2) 成本**
   - 第 k 個 chunk 會攜帶長度約 O(k) 的 `part.text` 再 stringify / fanout / reconcile 一次。
   - 長輸出或長 reasoning part 時，總成本會迅速放大。

4. **Subagent bridge 再把 full-part event 乘一次**
   - child streamed update 經 parent/global bus 再走一次 SSE/UI，對 subagent-heavy workload 更不利。

5. **舊 stale-delta guard 沒守到現行主熱路徑**
   - 當前熱路徑是 `message.part.updated` with optional `delta`，而不是獨立 `message.part.delta` emitter。

### Validation

- `packages/opencode/src/session/llm.ts:561-563`
  - 本地先組 `streamMessages` / `finalMessages`
- `packages/opencode/src/session/llm.ts:569-583`
  - `previousResponseId` 注入 provider options
- `packages/opencode/src/session/llm.ts:633-639`
  - 捕捉 `responseId` 供下輪使用
- `packages/opencode/src/session/llm.ts:764-777`
  - `ProviderTransform.message(...)` 發生在本地 messages 組裝之後
- `packages/opencode/src/plugin/codex.ts:749-761`
  - HTTP request body 在有 `previous_response_id` 時裁掉 input 前綴
- `packages/opencode/src/plugin/codex-websocket.ts:174-185`
  - WS request body 同樣裁掉 input 前綴
- `packages/opencode/src/session/processor.ts:619-625`
  - reasoning chunk 走 growing full part 更新
- `packages/opencode/src/session/processor.ts:1011-1020`
  - text chunk 走 growing full part 更新
- `packages/opencode/src/session/index.ts:970-978`
  - `updatePart()` 寫完整 part 並 publish `message.part.updated`
- `packages/opencode/src/session/message-v2.ts:480-485`
  - runtime event contract = `{ part, delta? }`
- `packages/opencode/src/server/routes/global.ts:349-354`
  - SSE 直接 `JSON.stringify(event)`
- `packages/app/src/context/global-sdk.tsx:97-100`
  - web coalescing key 以 `message.part.updated` 為主
- `packages/app/src/context/global-sdk.tsx:199-213`
  - 只做 frame-level coalescing
- `packages/app/src/context/global-sync/event-reducer.ts:264-315`
  - flush 後仍 full `part` reconcile
- `packages/opencode/src/cli/cmd/tui/context/sync.tsx:544-562`
  - TUI 每次 update 都 search + reconcile/splice
- `packages/opencode/src/tool/task.ts:224-235`
  - subagent `PartUpdated` 會 bridge 回 parent/global bus
- `packages/app/src/context/global-sdk.tsx:121`
  - stale `message.part.delta` guard 仍在，但 traced runtime 未見 active emitter

Architecture Sync: Verified (No doc changes)

- 本輪只做 RCA，未改變模組邊界、資料流或 state machine；`specs/architecture.md` 不需更新。

## 6. 後續建議

1. 在 `packages/opencode/src/session/index.ts:973-977` 加觀測：`delta.length`、`part.text.length`、publish count。
2. 在 `packages/opencode/src/server/routes/global.ts:349-354` 量 `JSON.stringify(event).length`，依 event type / part id 聚合。
3. 在 `packages/app/src/context/global-sdk.tsx:199-213` 統計 queued vs coalesced `message.part.updated` 次數。
4. 在 `packages/app/src/context/global-sync/event-reducer.ts:264-315` 與 `packages/opencode/src/cli/cmd/tui/context/sync.tsx:544-562` 量每次 reconcile/search 耗時。
5. 在 `packages/opencode/src/tool/task.ts:224-235` 統計 child session bridged `PartUpdated` 數量，確認 subagent 放大量。
6. 若要修補，優先考慮：
   - output path 改成真正 delta-aware transport，而不是 `full part + optional delta`
   - 降低 SSE full-event stringify/fanout
   - 讓 Web/TUI consumer 走 append-only/delta reconcile，而非每 chunk full reconcile
   - 重新對齊 stale-delta guard 與現行 `message.part.updated` 熱路徑

## 7. Timeout / Continuation Failure Follow-up

- 後續 timeout RCA 補充確認：`Codex WS: idle timeout waiting for response` 不能只解讀成「完全沒收到第一個 response」，因為 websocket idle timer 會在每個 frame 後 reset；若 stream 忙到一半 30 秒沒新 frame，也會走同一個錯誤字串。
- 因此要區分兩類邊界：
  1. `first-frame timeout`
  2. `mid-stream stall timeout`
- traced runtime 顯示 timeout / close-before-completion / first-frame fallback 並沒有一致清除 continuation state：
  - websocket state 的 `lastResponseId` / `lastInputLength`
  - session/llm 層的 Codex `responseId`
- 同時 HTTP fallback 使用的 `previous_response_id` 來自 session/llm continuation state，而不只依賴 websocket state；因此即使 websocket path 自己沒有注入，fallback 或下一輪仍可能沿用 stale continuation。
- 這會形成更具體的高信心因果鏈：
  1. 舊 response id 先前已被 capture
  2. 新一輪 websocket request 在 first-frame timeout 或 mid-stream stall 邊界失敗
  3. runtime 沒把 continuation 邊界視為 invalidation boundary
  4. fallback HTTP 或下一輪仍帶舊 `previous_response_id`
  5. upstream 回 `400 Previous response ... not found`
- 這也暴露 spec/runtime drift：`specs/codex/websocket/spec.md` 與 `tasks.md` 曾承諾 4xx/5xx 要 clear previous_response_id cache、`previous_response_not_found` 要 reset full context，但 traced runtime 未見完整對應實作。

### Timeout RCA Validation

- `packages/opencode/src/plugin/codex-websocket.ts:192-199`
  - idle timeout 將 stream 標 failed，但未一致清 continuation state
- `packages/opencode/src/plugin/codex-websocket.ts:244-256`
  - 只有部分 error event 路徑會清 `lastResponseId` / `lastInputLength`
- `packages/opencode/src/plugin/codex-websocket.ts:286-291`
  - `response.failed` 只清 `lastResponseId`
- `packages/opencode/src/plugin/codex-websocket.ts:300-316`
  - `onerror` / `onclose` 未一致清 continuation state
- `packages/opencode/src/plugin/codex-websocket.ts:351-358`
  - first-frame timeout fallback 未清 continuation state
- `packages/opencode/src/plugin/codex-websocket.ts:438-440`
  - WS path 會自動重灌 `previous_response_id`
- `packages/opencode/src/session/llm.ts:569-577`
  - HTTP path continuation 取自 session/llm state
- `packages/opencode/src/session/llm.ts:633-639`
  - runtime 會 capture `responseId`，但 traced code 未見對應清除路徑
