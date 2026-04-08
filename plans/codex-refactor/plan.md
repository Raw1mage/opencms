# Codex Provider Refactor — 單一計畫書

版本：2026-04-09 rev3
狀態：施工中

---

## 一、背景

Codex provider 散布在 opencode core 多個檔案中（codex.ts 960 行、codex-websocket.ts 653 行、codex-native.ts 318 行），透過 fetch interceptor hack 注入 protocol 行為。需重構為獨立的 `@opencode-ai/codex-provider` package。

V1 重構失敗的根因：convert 層從 type definition 猜格式，沒對照舊 provider 實際輸出。結果 tool call 不是不能用就是用了之後沒內容——system prompt 放錯欄位導致 AI 沒 context、tool result stringify 導致 AI 看到空內容、tool-call StreamPart 缺失導致 tool 不執行、finishReason 永遠 "stop" 導致 tool loop 不繼續。V2 的核心原則：**以 codex-rs 的程式協定為主要參考來源（upstream 權威），AI SDK adapter（1733 行）為次要參考——僅在 codex-rs 資訊不足的空缺處補充。任何格式轉換必須對照 golden-request.json 驗證，不准猜。**

前置修復（已完成）：compact_threshold 動態化 + SessionSnapshot 廢除。

---

## 二、需求

1. Codex provider 重構為獨立 package
2. 實作 `LanguageModelV2` interface，直接對接 Responses API
3. **request body 必須與舊 provider 的 golden output 逐欄位一致**
4. **response event → StreamPart 映射必須與舊 AI SDK adapter（1733 行）行為一致**
5. WS transport + delta + continuation 在 package 內部完成
6. opencode 主程式零 codex 硬編碼
7. **error handling 必須覆蓋：WS 斷線 fallback、4xx/5xx、rate limit、token refresh**
8. **account rotation 時 WS reset + per-account continuation preserve**

---

## 三、規格文件

### 權威來源（優先級由高到低）

1. **codex-rs 程式協定**：`refs/codex/codex-rs/` — upstream 權威，request/response 格式、WS handshake、header 定義的第一來源
2. **官方 API 文件**：https://developers.openai.com/api/docs
3. **Golden reference**：`golden-request.json`（request）— 舊 provider 的實際輸出，用於逐欄位比對驗證
4. **AI SDK adapter**（次要）：`openai-responses-language-model.ts`（1733 行）— 僅在 codex-rs 資訊不足時參考，補充 LanguageModelV2 介面映射的空缺

所有實作細節在 **[datasheet.md](datasheet.md)**。

---

## 四、Package 結構與依賴

```
packages/opencode-codex-provider/src/

protocol.ts     常數（URL, originator, timeouts）
                輸出：CODEX_API_URL, CODEX_WS_URL, ORIGINATOR, 各種 timeout

types.ts        API types
                輸出：ResponsesApiRequest, ResponseStreamEvent, CodexCredentials, etc.

convert.ts      AI SDK prompt → request body
                輸入：LanguageModelV2Prompt（system/user/assistant/tool messages）
                輸出：{ instructions: string, input: ResponseItem[] }
                實作：datasheet §2（六種 input item 格式）
                依賴：types.ts

headers.ts      HTTP/WS headers builder
                輸入：accessToken, accountId, turnState, window, sessionId
                輸出：Record<string, string>
                實作：originator, ChatGPT-Account-Id, x-codex-turn-state, x-codex-window-id

auth.ts         OAuth PKCE + token refresh
                輸出：refreshTokenWithMutex, generatePKCE, exchangeCodeForTokens, extractAccountId

sse.ts          Response events → LanguageModelV2StreamPart
                輸入：ReadableStream<ResponseStreamEvent>
                輸出：ReadableStream<LanguageModelV2StreamPart> + responseId promise
                實作：datasheet §4（完整 event mapping）
                狀態：ongoingToolCalls, currentTextId, activeReasoning, hasFunctionCall

models.ts       Model catalog + compact_threshold
                輸出：getCompactThreshold(modelId), getMaxOutput(modelId)

continuation.ts File-backed WS continuation state
                輸出：getContinuation, updateContinuation, invalidateContinuation
                持久化：$STATE/ws-continuation.json

transport-ws.ts WS transport + delta + first-frame probe
                輸入：sessionId, accessToken, accountId, body, wsUrl
                輸出：ReadableStream<ResponseStreamEvent> | null
                行為：WS 優先 → 失敗則 sticky HTTP fallback
                      account switch → close WS + preserve per-account continuation
                      delta mode → previous_response_id + input trim

provider.ts     CodexLanguageModel（LanguageModelV2 實作）
                輸入：callOptions（prompt, tools, providerOptions, headers）
                行為：1. ensureValidToken
                      2. convertPrompt → instructions + input
                      3. 從 providerOptions 映射 API fields（datasheet §5）
                      4. tryWsTransport → 成功則 mapResponseStream
                      5. 失敗則 HTTP fetch → parseSSEStream → mapResponseStream
                依賴：所有其他模組

index.ts        Public exports
```

### 整合點

| 檔案 | 修改 | 傳遞什麼 |
|---|---|---|
| `custom-loaders-def.ts` | codex loader | credentials → `createCodex()` |
| `plugin/codex-auth.ts` | OAuth auth | credentials returned to SDK |
| `plugin/index.ts` | import | `CodexNativeAuthPlugin` |
| `provider/provider.ts` | model def | `npm: "@opencode-ai/codex-provider"` |
| `provider/transform.ts` | options | `store=false` for codex |
| `session/llm.ts` | headers | `session_id`, `x-opencode-session` |

---

## 五、施工清單

### 已完成且驗證

| 項目 | 驗證方式 | 結果 |
|---|---|---|
| Package 建立 | `bun -e "import { createCodex } from ..."` | ✅ import 成功 |
| 整合 wiring | daemon 啟動 + `[CODEX-WS] REQ` trace | ✅ 新 provider 被呼叫 |
| WS transport 連線 | WS frame trace | ✅ connected + 多輪 frame |
| WS delta | `inputItems < fullItems` | ✅ R2+ delta mode |
| Cache reporting | `cacheReadTokens > 0` | ✅ R2: 5632, R3: 19200 |
| Session context | `cacheKey` 含 sessionId | ✅ 穩定 key |
| Tool call dispatch | `tool-call` StreamPart emitted | ✅ from output_item.done |
| Tool result format | content parts array passed | ✅ golden test 通過 |
| System prompt placement | developer role in input[0] | ✅ golden test 通過 |
| Content parts format | user=input_text, assistant=output_text | ✅ golden test 通過 |
| Tool schema | strict:false | ✅ golden test 通過 |
| providerOptions mapping | store, service_tier, reasoning 送出 | ⚠️ 寫了但未驗證實際 request dump |

### 已寫但未驗證

| 項目 | 缺什麼 |
|---|---|
| providerOptions 完整性 | 需 dump 新 provider request 對照 golden |
| HTTP fallback path | 未測試 WS 失敗後 HTTP 是否正常工作 |
| Account switch | 未測試多帳號切換時 WS reset 行為 |
| Token refresh mid-session | 未測試 OAuth 過期後 refresh 是否不中斷 |
| Continuation 持久化 | 未測試 daemon 重啟後 continuation restore |
| WS headers 比對 | 未 dump 新 provider WS headers 對照舊 |

### 待修（datasheet §6 gap analysis）

| 優先 | 項目 | 影響 |
|---|---|---|
| **高** | finishReason = "tool-calls" | tool loop 不繼續，AI 只做一輪 tool call 就停 |
| **高** | text-end flush | 懸掛 text part，stream 不乾淨結束 |
| 中 | text-start 自動補發 | Copilot item_id 變動時 text 丟失 |
| 中 | response.incomplete finishReason | 不完整回覆的原因丟失 |
| 中 | max_output_tokens 傳遞 | 可能影響長回覆 |
| 低 | response.created → response-metadata | 缺 timestamp metadata |
| 低 | annotation → source events | URL/file citation 不顯示 |
| 低 | reasoning encrypted_content metadata | reasoning 回放 |
| 低 | reasoning summary_part.added (index > 0) | 多段 reasoning |

### 待清理

- [ ] 移除舊 codex.ts 中的 CodexNativeAuthPlugin
- [ ] 移除 codex-websocket.ts
- [ ] 移除 codex-native.ts
- [ ] 移除 codex-compaction.ts 引用
- [ ] `grep -r "codex" src/ | grep -v plugin/codex` 驗證零殘留

---

## 六、驗證方法

### Happy path

| # | 項目 | 判定 | 狀態 |
|---|---|---|---|
| 1 | Golden diff (request) | top-level fields 一致 | ⚠️ 待 dump 驗證 |
| 2 | Tool call + result | AI 讀檔 → 完整回報內容 | ✅ 已通過 |
| 3 | Multi-turn | 3+ 輪含 tool call 全部正常 | ✅ 已通過 |
| 4 | WS delta | R2+ inputItems < fullItems | ✅ 已通過 |
| 5 | Cache hit | R2+ cacheReadTokens > 0 | ✅ 已通過 |
| 6 | Abort zero | 整個 session 無 abort | ⚠️ fix 後未重測 |
| 7 | Tool loop | AI 自主多次 tool call | ❌ 需 finishReason fix |

### Failure path

| # | 項目 | 判定 | 狀態 |
|---|---|---|---|
| 8 | WS 失敗 → HTTP fallback | response 正常回來 | ❌ 未測 |
| 9 | Rate limit | error 正確 propagate | ❌ 未測 |
| 10 | Token refresh | mid-session 不中斷 | ❌ 未測 |
| 11 | Account switch | WS reset + continuation preserve | ❌ 未測 |
| 12 | Daemon restart | continuation restore from disk | ❌ 未測 |
| 13 | Golden diff (response) | event sequence 一致 | ❌ 缺 response golden |

---

## 七、Revision History

| 日期 | 事件 |
|---|---|
| 2026-04-08 | 初始需求、upstream 分析、beta workflow、merge to main |
| 2026-04-08~09 | Hotfix 迭代 |
| 2026-04-09 | 計畫整併、datasheet（golden dump + 1733 行 adapter 分析 + 官方文件） |
| 2026-04-09 rev2 | Plan 重寫 |
| 2026-04-09 rev3 | Gap audit：§二加 error/account 需求、§四加依賴關係、§五分「已驗證/未驗證/待修」、§六分 happy/failure path + 狀態追蹤 |
