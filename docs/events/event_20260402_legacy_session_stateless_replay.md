# Event: Legacy session stateless replay compatibility

## 需求

- 修復舊 session 在重啟後無法繼續接話的向下相容問題。
- 症狀為續聊時出現 `text part msg_... not found`，導致回覆失敗。

## 範圍

### IN

- `/home/pkcs12/projects/opencode/packages/opencode/src/provider/sdk/copilot/responses/convert-to-openai-responses-input.ts`
- `/home/pkcs12/projects/opencode/packages/opencode/src/provider/sdk/copilot/responses/openai-responses-api-types.ts`
- `/home/pkcs12/projects/opencode/packages/opencode/src/provider/sdk/copilot/responses/convert-to-openai-responses-input.test.ts`

### OUT

- 不改動 session persistence schema。
- 不全域移除 persisted provider metadata。
- 不在前端新增掩蓋資料問題的 fallback。

## 任務清單

- [x] 閱讀 architecture 與當日 event，確認 session / prompt / provider 邊界
- [x] 追查 `text part msg_... not found` 的真正來源
- [x] 確認 root cause 為 Responses `store:false` stateless replay 仍送出舊 remote item references
- [x] 在 Responses outbound serializer 修補 `store:false` 行為
- [x] 新增 serializer 目標測試覆蓋 assistant text / reasoning / local shell replay
- [x] 執行最小額外驗證（typecheck + 鄰近 provider transform 測試）

## 對話重點摘要

- 使用者回報：重啟成功後，舊 session 無法再接話，畫面會出現 `message part`/`text part msg_... not found` 類錯誤。
- 初步懷疑是前端 message-part store 缺資料；進一步追查後排除前端 reducer 為主因。
- 錯誤實際來自上游 API 回應，被 provider/session error surface 原樣帶回 UI。

## Debug Checkpoints

### Baseline

- 重現情境：重啟後進入舊 session，送出新訊息續聊。
- 症狀：reply 區域出現 `text part msg_... not found`，續聊失敗。
- 影響範圍：舊 session、同模型續聊、OpenAI/Copilot Responses replay 路徑。
- 初始假設：舊 session 的 persisted message/part 與新版 runtime replay 契約不相容。

### Instrumentation Plan

- 沿著 `session -> message-v2 -> provider transform -> Responses input serializer -> provider error surfacing` 追資料流。
- 檢查前端 `global-sync` reducer 是否會因缺 part 直接 throw。
- 比對 `store:false` 與 persisted `providerMetadata.itemId` 的互動。

### Execution

- 確認 repo 內沒有自造 `text part ... not found` 字串，推定為上游 API error passthrough。
- 確認 `MessageV2.toModelMessages(...)` 會在同模型續聊時保留 text part `providerMetadata`。
- 確認 `convert-to-openai-responses-input.ts` 會把 `providerOptions.openai.itemId` 序列化成 assistant/function/local shell/reasoning replay 參照。
- 確認 OpenAI / GitHub Copilot 類請求預設 `store:false`，因此 replay 屬 stateless 模式，不應再送回舊 remote item references。
- 實作 `getReplayItemId(...)`，讓 `store:false` 時 assistant text、function call、local shell call 省略 replay remote `id`。
- 保留 `call_id` 等本地語意；`store:true` 路徑維持既有行為。

### Root Cause

- 舊 session 的 assistant text / reasoning / tool-call parts 帶有先前執行留下的 remote `itemId` metadata。
- 續聊時，同模型 replay 保留這些 metadata；Responses input serializer 又在 `store:false` 下仍把它們輸出成 remote `id` / `item_reference`。
- Stateless replay 無法保證上游仍保有對應 stored item，API 因而回 `text part msg_... not found`。
- 前端只是顯示這個上游錯誤，不是根因。

### Validation

- Serializer 目標測試：
  - `bun test "/home/pkcs12/projects/opencode/packages/opencode/src/provider/sdk/copilot/responses/convert-to-openai-responses-input.test.ts"` ✅
- 額外驗證：
  - `bun run typecheck`（workdir=`/home/pkcs12/projects/opencode/packages/opencode`）✅
  - `bun test "/home/pkcs12/projects/opencode/packages/opencode/test/provider/transform.test.ts"`（workdir=`/home/pkcs12/projects/opencode/packages/opencode`）✅ `87 pass / 0 fail`
- Architecture Sync: Verified (No doc changes)
  - 依據：本次僅修正 OpenAI/Copilot Responses outbound serializer 在 stateless replay 的相容邏輯，未改變長期模組邊界、資料流主幹或狀態機定義。

## Key Decisions

- 修補點放在 Responses outbound serializer，而不是 session persistence 或前端 render 層。
- 不用全域移除 provider metadata；只在 `store:false` 的 API input 邊界剝除 remote-reference semantics。
- 保持 `store:true` 既有 replay 行為不變，將 blast radius 限制在 stateless replay。

## Remaining

- 殘餘風險：目前仍缺少一個從 `session/message-v2 -> responses serializer` 的整合測試，覆蓋「真實舊 session 續聊」情境。
- 以現有證據可本地 merge / ship，但若要更穩，建議後續補上 session 層整合測試。
