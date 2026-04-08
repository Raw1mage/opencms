# Codex Provider — Complete Protocol Datasheet

## Purpose

本文件是 native codex provider 的**唯一施工圖**。任何人根據這份文件必須能還原程式的每一個細節，不需要猜測。

所有欄位值都來自**舊 provider 的實際 dump**（`golden-request.json`），不是從 codex-rs type definition 推導的。

---

## 1. Request Body（WS mode）

### 1.1 Top-Level Fields

| Field | 值 | 來源 | 必須 |
|---|---|---|---|
| `type` | `"response.create"` | WS protocol | 是 |
| `model` | `"gpt-5.4"` 等 | session config | 是 |
| `instructions` | `"You are a helpful assistant."` | **固定 placeholder** | 是 |
| `input` | ResponseItem[] | 見 §2 | 是 |
| `tools` | function[] | 見 §3 | 有 tool 時 |
| `tool_choice` | `"auto"` | 固定 | 有 tool 時 |
| `store` | `false` | ProviderTransform.options | 是 |
| `service_tier` | `"priority"` | codex provider 專用 | 是 |
| `include` | `["reasoning.encrypted_content"]` | opencode provider 專用，codex 目前無 | 條件 |
| `reasoning` | `{effort: "medium", summary: "auto"}` | gpt-5.x 系列 | 條件 |
| `text` | `{verbosity: "low"}` | gpt-5.x 非 codex 型號 | 條件 |
| `prompt_cache_key` | `"ses_{sessionID}"` | ProviderTransform.options | 是 |
| `context_management` | `[{type: "compaction", compact_threshold: N}]` | 80% of context window | 是 |
| `previous_response_id` | `"resp_xxx"` | WS delta mode | 條件 |

### 1.2 WS 不送的 Fields

| Field | 說明 |
|---|---|
| `stream` | WS 本身就是 streaming，不需要此 field |
| `parallel_tool_calls` | 舊 adapter 不送 |
| `client_metadata` | 舊 adapter 不送（新 provider 可選送） |
| `max_tokens` | Codex API 不需要 |
| `temperature` | codex model 不支援 |

### 1.3 HTTP mode 額外 Fields

| Field | 值 |
|---|---|
| `stream` | `true` |

---

## 2. Input Items（input[] array）

### 2.1 Item 順序

```
[0] role=developer   content="完整 system prompt"（31K+ chars）
[1] role=user         content="用戶訊息"
[2] type=function_call         （AI 回的 tool call）
[3] type=function_call_output  （tool 執行結果）
[4] role=user         content="下一輪用戶訊息"
...
```

### 2.2 developer message（system prompt）

```json
{
  "role": "developer",
  "content": "# Codex Driver\n\nYou are TheSmartAI.\n\n..."
}
```

- `content` 是 **string**（不是 array）
- system prompt 放 `input[0]` 作為 `developer` role，**不放 `instructions`**
- `instructions` 只是 `"You are a helpful assistant."` placeholder

### 2.3 user message

```json
{ "role": "user", "content": [{ "type": "input_text", "text": "讀取 ARCHITECTURE.md" }] }
```

- `content` **一律是 content parts array**，不用 string
- 圖片：`[{ "type": "input_image", "image_url": "data:image/png;base64,..." }]`

### 2.4 assistant message

```json
{ "role": "assistant", "content": [{ "type": "output_text", "text": "回覆文字" }] }
```

- `content` **一律是 content parts array**，不用 string
- 注意 type 是 `output_text`（不是 `input_text`）

### 2.5 function_call（AI 發起的 tool call）

```json
{
  "type": "function_call",
  "call_id": "call_xxx",
  "name": "read",
  "arguments": "{\"filePath\":\"/path/to/file\"}"
}
```

- `arguments` 是 **JSON 字串**，不是物件

### 2.6 function_call_output（tool 執行結果）

```json
{
  "type": "function_call_output",
  "call_id": "call_xxx",
  "output": [{ "type": "input_text", "text": "...檔案內容..." }]
}
```

- `output` 是 **content parts array**（`[{type: "input_text", text: "..."}]`）
- **不是字串**。`JSON.stringify()` 會讓 AI 看到空內容
- AI SDK 把 tool result 包裝成這個格式，必須原封不動傳遞

---

## 3. Tool Schema

```json
{
  "type": "function",
  "name": "bash",
  "description": "Execute a bash command...",
  "parameters": { "type": "object", "properties": {...}, "required": [...] },
  "strict": false
}
```

**注意**：`strict: false` 必須存在。

---

## 4. Response Event → StreamPart 映射

### 4.1 Text streaming

| Server Event | StreamPart | 觸發 |
|---|---|---|
| `response.output_item.added` (type=message) | `text-start` | UI |
| `response.output_text.delta` | `text-delta` | UI |
| `response.output_text.done` | `text-end` | UI |

### 4.2 Tool call（**最關鍵的部份**）

| Server Event | StreamPart | 觸發 |
|---|---|---|
| `response.output_item.added` (type=function_call) | `tool-input-start` | UI |
| `response.function_call_arguments.delta` | `tool-input-delta` | UI（可能被 obfuscated） |
| `response.function_call_arguments.done` | （不處理，arguments 可能是空的） | — |
| **`response.output_item.done`** (type=function_call) | **`tool-input-end` + `tool-call`** | **Tool execution** |

**關鍵**：
- `tool-call` 是觸發 AI SDK tool execution 的**唯一機制**
- `tool-call.input` 從 `output_item.done` 的 `item.arguments` 取值
- streaming delta 可能被 server obfuscated（`delta="{}"`），**不可依賴**
- `tool-input-end` 不觸發 execution，只通知 UI

### 4.3 Reasoning

| Server Event | StreamPart |
|---|---|
| `response.reasoning_summary_text.delta` | `reasoning-start` + `reasoning-delta` |
| `response.reasoning_summary_text.done` | `reasoning-end` |

### 4.4 Finish

| Server Event | StreamPart | 數據 |
|---|---|---|
| `response.completed` | `finish` | `usage.inputTokens`, `outputTokens`, `cachedInputTokens`, `reasoningTokens`, `responseId` |

`cachedInputTokens` 從 `response.usage.input_tokens_details.cached_tokens` 取。

---

## 5. providerOptions Pipeline

### 5.1 來源

`ProviderTransform.options()` 根據 model 特性產出，然後被 `ProviderTransform.providerOptions()` 包裝在 provider key 下。

### 5.2 codex provider 的 options

| Option (camelCase) | API Field (snake_case) | 值 | 條件 |
|---|---|---|---|
| `store` | `store` | `false` | 需要 `providerId === "codex"` 加入判斷 |
| `promptCacheKey` | `prompt_cache_key` | `sessionID` | 固定 |
| `serviceTier` | `service_tier` | `"priority"` | 固定 |
| `reasoningEffort` | `reasoning.effort` | `"medium"` | gpt-5.x, 非 pro |
| `reasoningSummary` | `reasoning.summary` | `"auto"` | gpt-5.x, 非 pro |
| `textVerbosity` | `text.verbosity` | `"low"` | gpt-5.x 非 codex 非 chat |
| `include` | `include` | `["reasoning.encrypted_content"]` | opencode provider only（codex 目前無） |

### 5.3 Provider 讀取路徑

```
callOptions.providerOptions.codex.{key}
  ?? callOptions.providerOptions.openai.{key}
  ?? callOptions.providerOptions.{key}
```

---

## 6. WS Transport

### 6.1 Connection

- URL: `wss://chatgpt.com/backend-api/codex/responses`
- Headers: `Authorization`, `originator`, `OpenAI-Beta`, `chatgpt-account-id`, `x-codex-turn-state`

### 6.2 Delta Mode

- 第一次 request: `previous_response_id` 無，送全量 input
- 後續 request: `previous_response_id` = 上次 `response.completed` 的 `response.id`，input 只送新增 items

### 6.3 Continuation

- `lastResponseId` + `lastInputLength` 持久化到 `ws-continuation.json`
- Compaction 後清除（WS reset + window generation advance）

---

## 7. 已知的陷阱

| 陷阱 | 說明 | 正確做法 |
|---|---|---|
| instructions 放 system prompt | AI 行為異常，回覆過短 | system prompt → `input[0]` developer role |
| tool result stringify | AI 看不到 tool 執行結果 | array output 直接傳，不 stringify |
| tool-call 缺失 | tool 不被執行 | 從 `output_item.done` emit `tool-call` |
| streaming delta obfuscation | arguments 是 `"{}"` | 忽略 delta，從 `output_item.done` 取 arguments |
| 缺 reasoning/service_tier/store | server 降級回應 | 從 providerOptions pipeline 完整映射 |
| tool schema 缺 strict | 可能影響 schema validation | 加 `strict: false` |

---

## 8. Golden Reference

完整的舊 provider WS request dump：`plans/codex-refactor/golden-request.json`

此檔案是所有格式轉換的**唯一真相來源**。新 provider 的 output 必須能通過與此檔案的 field-level diff。
