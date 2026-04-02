# Event: text part msg live instrumentation

## 需求

- 追查目前 branch 仍可重現的 `text part msg_... not found`。
- 補最小 instrumentation，判斷 stale remote reference 是在 checkpoint/compaction、message replay、responses serializer，還是 provider fetch scrub 邊界漏出。

## 範圍

### IN

- `/home/pkcs12/projects/opencode/packages/opencode/src/session/prompt.ts`
- `/home/pkcs12/projects/opencode/packages/opencode/src/session/message-v2.ts`
- `/home/pkcs12/projects/opencode/packages/opencode/src/provider/sdk/copilot/responses/convert-to-openai-responses-input.ts`
- `/home/pkcs12/projects/opencode/packages/opencode/src/provider/provider.ts`
- `/home/pkcs12/projects/opencode/packages/opencode/src/provider/sdk/copilot/responses/convert-to-openai-responses-input.test.ts`

### OUT

- 不新增 fallback 或掩蓋 provider error 的 UI 行為。
- 不直接修改 provider replay 邏輯語意；本次以診斷為主。
- 不記錄敏感 prompt 全文或大段 request body。

## 任務清單

- [x] 讀取 architecture 與既有 event，建立 `text part msg_*` 的已知 root cause 與邊界圖。
- [x] 檢查 active debug log / cyclebin，確認目前可觀測證據缺口。
- [x] 收斂本地 remote item id 注入點與 request shape。
- [x] 在 prompt / replay / serializer / fetch wrapper 加最小 instrumentation。
- [x] 執行最小必要測試。
- [ ] 用新 instrumentation 再重現一次錯誤並回收新證據。

## 對話重點摘要

- 使用者指出目前 branch 仍會出現 `text part msg_* not found`，而且錯誤時間點常出現在大量讀檔後、準備進入下一輪回覆時。
- 初始懷疑包含：provider stale item reference、checkpoint/compaction/rebind 導致上下文縮寫後沿用舊 remote id、以及純對話 replay 路徑。
- 後續收斂出兩個重要限制：本輪沒有 restart，因此可排除 restart rebind；本輪為純對話，因此 toolcall replay 降權。
- 使用者也要求釐清 `msg_*` 是否為通用協議；結論是它較像特定 responses/item-reference 路徑的遠端 item/message ID，不應泛化為所有 provider 的通用協議字面。

## Debug Checkpoints

### Baseline

- 現象：目前 branch 可再次重現 `text part msg_... not found`。
- active debug log 可以看到對 `https://chatgpt.com/backend-api/codex/responses` 的 POST，以及訊息 parts 帶有 `metadata.codex.itemId`，但看不到 provider error body / scrub 後 payload。
- 既有 event 已證明先前至少有一條 root cause 是 stateless replay 仍送出舊 remote item references。

### Instrumentation Plan

- 在 `prompt.ts` 記錄是否真的套用 checkpoint / 哪種 compaction / boundary 後訊息摘要。
- 在 `message-v2.ts` 記錄純 text/reasoning replay 保留了多少 remote `itemId` metadata。
- 在 `convert-to-openai-responses-input.ts` 記錄 `store`、`idCount`、`itemReferenceCount`、type 分布。
- 在 `provider.ts` 記錄 scrub 前後 request 摘要，以及 non-OK response 的 status + 短摘要。
- 所有埋點僅記計數/型別/短摘要，不記 prompt 全文。

### Execution

- 確認本地真正會把遠端 item id 注入 outgoing request 的核心點只有兩段：
  1. `message-v2` 保留 `providerMetadata`
  2. `convert-to-openai-responses-input` 把 metadata 轉成 top-level `id` 或 `item_reference`
- 確認 `prompt.ts` / compaction 不直接產生 `msg_*`，它只決定哪些訊息被保留去 replay。
- 確認 `provider.ts` 在 OpenAI/Codex 類 POST 會刪 top-level `id`，但不刪 `item_reference`。
- 新增 instrumentation 後，現在可觀測：
  - request 是否 `store:false`
  - serializer 前後 `idCount` / `itemReferenceCount`
  - scrub 前後差異
  - non-OK response 短摘要

### Current Root-Cause Hypothesis

- 新證據已將 root cause 收斂為 **account-scoped remote refs 被同 provider 不同 account 重用**。
- 關鍵 causal chain：
  1. `message-v2` replay gate 保留 provider metadata 時只比較 `providerId/modelID`，沒有把 `accountId` 納入 identity boundary。
  2. 同 provider + 同 model 換 account 時，舊 assistant/reasoning parts 的 remote `itemId` metadata 仍會保留。
  3. serializer 再把這些 metadata 轉成 outbound `id` / `item_reference`。
  4. 新 account 對應的遠端狀態不認得舊 account 的 `msg_*` / related refs，因而回 `text part msg_... not found`。
- restart rebind 已因「沒有重啟」降權；toolcall replay 已因「純對話」降權；checkpoint/compaction 現在更像放大 replay stale-ref 風險的背景條件，而非首因。

### Validation

- Instrumentation / diagnosis validation:
  - `bun test /home/pkcs12/projects/opencode/packages/opencode/src/provider/sdk/copilot/responses/convert-to-openai-responses-input.test.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/compaction.test.ts /home/pkcs12/projects/opencode/packages/opencode/src/session/prompt-context-sharing.test.ts` ✅ (`11 pass / 0 fail`)
- Replay-gate fix validation:
  - `bun test "/home/pkcs12/projects/opencode/packages/opencode/src/session/message-v2.test.ts" "/home/pkcs12/projects/opencode/packages/opencode/src/provider/sdk/copilot/responses/convert-to-openai-responses-input.test.ts"` ✅ (`6 pass / 0 fail`)
- `bun x tsc -p /home/pkcs12/projects/opencode/tsconfig.json --noEmit` ⚠️ 失敗，但失敗源自既有 generated build artifacts：`packages/opencode-codex-provider/build/CMakeFiles/.../compiler_depend.ts`，非本次修改檔案。
- Architecture Sync: Verified (No doc changes)
  - 依據：本次新增 instrumentation 並修正既有 replay identity gate 對 account boundary 的判定，未改變長期模組邊界、核心資料流主幹或狀態機定義。

## Key Decisions

- 先補 instrumentation，再用使用者提供的「同 provider 換 account 即炸」新證據收斂 root cause。
- `msg_*` 視為 provider-specific responses/item reference 字面，不視為跨 provider 通用協議。
- replay identity boundary 必須與 session execution identity 對齊；`accountId` 不能被忽略。
- 最小修補點放在 `message-v2` replay gate：同 provider + 同 model 但 account 改變時，不保留舊 remote metadata。

## Remaining

- 需要使用新修補 + instrumentation 再重現一次，確認 `text part msg_* not found` 在 account switch 情境下已消失。
- 若仍有殘餘案例，下一個檢查點是 `codex.ts` 的 HTTP sticky turn state 是否需要改成 `sessionID + accountId` 分桶。