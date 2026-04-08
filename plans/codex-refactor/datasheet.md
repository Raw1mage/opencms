# Codex Provider — Complete Protocol Datasheet

## Purpose

本文件是 native codex provider 的**唯一施工圖**。

### 權威來源（優先順序）

1. **OpenAI Responses API 官方文件**（聖經）：https://developers.openai.com/api/docs
   - Request body: https://developers.openai.com/api/docs/guides/migrate-to-responses
   - Function calling: https://developers.openai.com/api/docs/guides/function-calling
   - Streaming events: https://developers.openai.com/api/docs/guides/streaming-responses
   - WebSocket mode: https://developers.openai.com/api/docs/guides/websocket-mode
   - Tools: https://developers.openai.com/api/docs/guides/tools
2. **Golden request dump**（`golden-request.json`）：舊 provider 的實際 WS request
3. **AI SDK adapter 原始碼**（`openai-responses-language-model.ts`, 1733 行）：實戰驗證的映射邏輯

當三者有衝突時，以官方文件為準。golden dump 用於驗證格式，AI SDK adapter 用於補充官方文件未涵蓋的實作細節。

### 官方文件關鍵規格摘要

**function_call_output.output 格式**（官方）：
> "you can pass an array of image or file objects instead of a string"

→ output 可以是 string 或 content parts array。AI SDK 使用 array 格式。

**WS mode 與 HTTP 差異**（官方）：
> "Transport-specific fields like `stream` and `background` are not used" in WebSocket mode.

→ WS 不送 `stream` 和 `background`。

**store 預設值**（官方）：`default: true`
→ 必須明確設 `false`，否則 response 會被存儲。

**previous_response_id**（官方）：
> "The service maintains one previous-response state in a connection-local in-memory cache."

→ WS 連線內的 continuation 是 server 端 cache，不是 client 請求。

---

## 1. Request Body（WS mode）

Golden reference: `golden-request.json`

### 1.1 Top-Level Fields

| Field | 值 | 來源 | WS | HTTP |
|---|---|---|---|---|
| `type` | `"response.create"` | WS protocol | 送 | 不送 |
| `model` | `"gpt-5.4"` 等 | session config | 送 | 送 |
| `instructions` | `"You are a helpful assistant."` | 固定 placeholder | 送 | 送 |
| `input` | ResponseItem[] | §2 | 送 | 送 |
| `tools` | function[] | §3 | 送 | 送 |
| `tool_choice` | `"auto"` | 固定 | 送 | 送 |
| `store` | `false` | providerOptions | 送 | 送 |
| `service_tier` | `"priority"` | codex 專用 | 送 | 送 |
| `include` | `["reasoning.encrypted_content"]` | 條件 | 送 | 送 |
| `reasoning` | `{effort, summary}` | §5 | 送 | 送 |
| `text` | `{verbosity}` | §5 | 送 | 送 |
| `prompt_cache_key` | `"ses_{sessionID}"` | providerOptions | 送 | 送 |
| `context_management` | `[{type:"compaction", compact_threshold:N}]` | 80% context | 送 | 送 |
| `previous_response_id` | `"resp_xxx"` | WS delta | 條件 | 不送 |
| `stream` | — | — | **不送** | `true` |
| `parallel_tool_calls` | — | — | **不送** | **不送** |
| `client_metadata` | — | — | 可選 | 可選 |
| `max_tokens` / `temperature` | — | — | **不送** | **不送** |
| `max_output_tokens` | number | AI SDK adapter 送 | 送 | 送 |
| `top_p` | — | reasoning model 不送 | — | — |

---

## 2. Input Items

### 2.1 developer message

```json
{ "role": "developer", "content": "完整 system prompt 字串（17K~38K chars）" }
```
- `content` 是 **string**
- 放 `input[0]`，不放 `instructions`

### 2.2 user message

```json
{ "role": "user", "content": [{ "type": "input_text", "text": "..." }] }
```
- `content` **一律是 array**
- 圖片：`[{ "type": "input_image", "image_url": "..." }]`
- 混合：`[{ "type": "input_text", ... }, { "type": "input_image", ... }]`

### 2.3 assistant message

```json
{ "role": "assistant", "content": [{ "type": "output_text", "text": "..." }] }
```
- `content` **一律是 array**
- type 是 `output_text`（**不是** `input_text`）

### 2.4 function_call

```json
{ "type": "function_call", "call_id": "call_xxx", "name": "read", "arguments": "{\"filePath\":\"...\"}" }
```
- `arguments` 是 **JSON 字串**

### 2.5 function_call_output

```json
{ "type": "function_call_output", "call_id": "call_xxx", "output": [{ "type": "input_text", "text": "..." }] }
```
- `output` 是 **content parts array**，不是字串
- AI SDK 把 tool result 包裝成 `[{type: "input_text", text: "..."}]`

---

## 3. Tool Schema

```json
{ "type": "function", "name": "bash", "description": "...", "parameters": {...}, "strict": false }
```
- `strict: false` 必須存在

---

## 4. Response Event → StreamPart 完整映射

來源：`openai-responses-language-model.ts` lines 838-1316

### 4.1 output_item.added（11 種 item type）

| item.type | StreamPart | 行為 |
|---|---|---|
| `message` | `text-start {id: item.id}` | 記錄 currentTextId |
| `reasoning` | `reasoning-start {id: item.id+":0"}` | 含 encryptedContent metadata |
| `function_call` | `tool-input-start {id: item.call_id, toolName: item.name}` | 記錄 ongoingToolCalls |
| `web_search_call` | `tool-input-start {id: item.id, toolName}` | |
| `computer_call` | `tool-input-start {id: item.id, toolName: "computer_use"}` | |
| `code_interpreter_call` | `tool-input-start` + `tool-input-delta` (containerId prefix) | |
| `file_search_call` | `tool-call {providerExecuted: true, input: "{}"}` | 立即 emit tool-call |
| `image_generation_call` | `tool-call {providerExecuted: true, input: "{}"}` | 立即 emit tool-call |
| `local_shell_call` | （added 不處理，done 時處理） | |

### 4.2 output_item.done（10 種 item type）

| item.type | StreamPart 序列 | 關鍵欄位 |
|---|---|---|
| `function_call` | `tool-input-end` → **`tool-call {input: item.arguments}`** | **arguments 從此處取** |
| `web_search_call` | `tool-input-end` → `tool-call` → `tool-result {result: {status}}` | providerExecuted |
| `computer_call` | `tool-input-end` → `tool-call` → `tool-result` | providerExecuted |
| `file_search_call` | `tool-result {result: {queries, results}}` | providerExecuted |
| `code_interpreter_call` | `tool-result {result: {outputs}}` | providerExecuted |
| `image_generation_call` | `tool-result {result: {result: item.result}}` | providerExecuted |
| `local_shell_call` | `tool-call {input: JSON.stringify({action: ...})}` | |
| `message` | `text-end {id: currentTextId}` | 清除 currentTextId |
| `reasoning` | `reasoning-end` (每個 summaryPart 一個) | 含 encryptedContent |

### 4.3 Streaming Delta Events

| Event | StreamPart | 備註 |
|---|---|---|
| `response.output_text.delta` | `text-delta {id: currentTextId, delta}` | 如果 currentTextId 不存在，先 emit text-start |
| `response.function_call_arguments.delta` | `tool-input-delta {id: toolCallId, delta}` | **可能被 obfuscated，不可用於 execution** |
| `response.code_interpreter_call.code.delta` | `tool-input-delta` (JSON-escaped code) | |
| `response.code_interpreter_call.code.done` | `tool-input-delta("}")` → `tool-input-end` → `tool-call` | |
| `response.image_generation_call.partial_image` | `tool-result` (partial) | |
| `response.reasoning_summary_part.added` | `reasoning-start` (index > 0 時) | |
| `response.reasoning_summary_text.delta` | `reasoning-delta` | |

### 4.4 Finish Events

| Event | StreamPart | 欄位 |
|---|---|---|
| `response.created` | `response-metadata {id, timestamp, modelId}` | |
| `response.completed` / `response.incomplete` | (記錄 usage + finishReason) | |
| flush (stream end) | `finish {finishReason, usage, providerMetadata}` | `text-end` if dangling |

### 4.5 Usage 結構

```typescript
usage.inputTokens = response.usage.input_tokens
usage.outputTokens = response.usage.output_tokens
usage.totalTokens = input_tokens + output_tokens
usage.reasoningTokens = response.usage.output_tokens_details?.reasoning_tokens
usage.cachedInputTokens = response.usage.input_tokens_details?.cached_tokens
```

### 4.6 finishReason 映射

- `response.completed` + 有 function_call → `"tool-calls"`
- `response.completed` + 無 function_call → `"stop"`
- `response.incomplete` + reason → 根據 reason 映射
- 其他 → `"other"`

### 4.7 Error Event

```json
{ "type": "error", "code": "...", "message": "...", "sequence_number": N }
```
→ `{ type: "error", error: value }`

### 4.8 Annotation Events

| annotation.type | StreamPart |
|---|---|
| `url_citation` | `source {sourceType: "url", url, title}` |
| `file_citation` | `source {sourceType: "document", title, filename}` |

### 4.9 State Management

| State | 用途 |
|---|---|
| `ongoingToolCalls[output_index]` | 追蹤進行中的 tool call（toolName, toolCallId） |
| `currentTextId` | 穩定的 text part ID（Copilot 可能換 item_id） |
| `activeReasoning[output_index]` | 追蹤 reasoning（canonicalId, encryptedContent, summaryParts） |
| `currentReasoningOutputIndex` | 當前 reasoning 的 output_index |
| `hasFunctionCall` | 有 client-side tool call → finishReason = "tool-calls" |
| `responseId` | 從 response.created 取 |

---

## 5. providerOptions 映射

| camelCase | API field | 值 | 條件 |
|---|---|---|---|
| `store` | `store` | `false` | codex/openai provider |
| `promptCacheKey` | `prompt_cache_key` | sessionID | 固定 |
| `serviceTier` | `service_tier` | `"priority"` | codex 專用 |
| `reasoningEffort` | `reasoning.effort` | `"medium"` | gpt-5.x, reasoning model |
| `reasoningSummary` | `reasoning.summary` | `"auto"` | gpt-5.x, reasoning model |
| `textVerbosity` | `text.verbosity` | `"low"` | gpt-5.x 非 codex 非 chat |
| `include` | `include` | `["reasoning.encrypted_content"]` | opencode provider only |
| `instructions` | `instructions` | placeholder | — |
| `previousResponseId` | `previous_response_id` | — | WS delta |
| `parallelToolCalls` | `parallel_tool_calls` | — | 舊 adapter 不送 |
| `maxToolCalls` | `max_tool_calls` | — | 可選 |
| `metadata` | `metadata` | — | 可選 |
| `user` | `user` | — | 可選 |
| `logprobs` | `top_logprobs` | — | 可選 |

---

## 6. 我的 sse.ts 缺少的 event handlers

對照 §4 的完整映射，以下是 `sse.ts` 目前**沒有處理**的事件：

| Event | 影響 | 優先級 |
|---|---|---|
| `response.created` → `response-metadata` | 缺 timestamp/modelId metadata | 低 |
| `response.incomplete` → finishReason 映射 | 可能誤報 finishReason | 中 |
| `text-start` 自動補發（delta 前無 added） | Copilot item_id 變動 | 中 |
| `text-end` 在 flush 時補發 | 懸掛的 text part | 中 |
| `reasoning` summary_part.added (index > 0) | 多段 reasoning | 低 |
| `reasoning` encrypted_content metadata | reasoning 回放 | 低 |
| `annotation` → `source` | URL/file citation | 低 |
| `finishReason = "tool-calls"`（有 function_call 時） | AI SDK loop 判斷 | **高** |
| `web_search_call` / `computer_call` / `code_interpreter_call` / `image_generation_call` / `local_shell_call` / `file_search_call` | provider-executed tools | 低（opencode 不用） |

### 最高優先修復

**`finishReason = "tool-calls"`**：舊 adapter 在有 `function_call` 時回報 `"tool-calls"` 而非 `"stop"`。AI SDK 的 `streamText` 用這個判斷是否繼續 tool loop。我的 sse.ts 永遠回報 `"stop"`，可能導致 tool loop 提前結束。

---

## 7. 已知陷阱

| # | 陷阱 | 後果 | 正確做法 |
|---|---|---|---|
| 1 | System prompt 放 `instructions` | AI 沒 context | `input[0]` developer role |
| 2 | Tool result 用 `JSON.stringify()` | AI 看到空內容 | Array output 直接傳 |
| 3 | 只 emit `tool-input-end` | Tool 不執行 | 必須 emit `tool-call` |
| 4 | 從 streaming delta 取 arguments | 被 obfuscated `"{}"` | 從 `output_item.done` 取 |
| 5 | 缺 `reasoning`/`store`/`service_tier` | Server 降級回應 | providerOptions 完整映射 |
| 6 | Tool schema 缺 `strict: false` | Schema 差異 | 加上 |
| 7 | WS 送 `stream: true` | 格式差異 | 只 HTTP 送 |
| 8 | user/assistant content 用 string | 格式差異 | 一律 content parts array |
| 9 | assistant type 用 `input_text` | 格式差異 | 必須用 `output_text` |
| 10 | finishReason 永遠 "stop" | Tool loop 可能不繼續 | 有 function_call 時回 "tool-calls" |
| 11 | 缺 text-end flush | 懸掛 text part | stream 結束時補發 |

---

## 8. Golden Reference

`golden-request.json` — 舊 provider 的實際 WS request dump。所有格式轉換的唯一真相來源。
