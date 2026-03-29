# Design

## Context

codex provider 目前有兩條路徑：
1. **AI SDK path**（正常運作）：`sdk.responses(modelId)` → custom fetch interceptor → HTTP SSE
2. **CUSTOM_LOADER path**（已停用）：`CodexLanguageModel.doStream()` → WebSocket/C binary

CUSTOM_LOADER 試圖取代 AI SDK 的整個 stream pipeline，但缺少大量功能導致 tool call、lifecycle、併發全部壞掉。

---

## AI SDK 架構分析

### 程式碼分佈（v2.0.89）

| Package | 行數 | 檔案 | 職責 |
|---------|------|------|------|
| `ai` (core) | 10,126 | `node_modules/ai/dist/index.js` | streamText、tool loop、eventProcessor、fullStream |
| `@ai-sdk/openai` | 4,671 | `node_modules/@ai-sdk/openai/dist/index.js` | Responses API model adapter |
| `@ai-sdk/provider-utils` | ~2,850 | `node_modules/@ai-sdk/provider-utils/dist/index.js` | schema validation、JSON parse |
| `@ai-sdk/openai-compatible` | ~1,647 | `node_modules/@ai-sdk/openai-compatible/dist/index.js` | 通用 OpenAI adapter |
| `@ai-sdk/provider` | ~420 | `node_modules/@ai-sdk/provider/dist/index.d.ts` | LanguageModelV2 interface |

### streamText 完整 Pipeline（7 個 transform stage）

```
streamText(options)                              [line 4513]
  │
  └─ new DefaultStreamTextResult(...)            [line 4646]
       │
       ├─ 3 × DelayedPromise (_totalUsage, _finishReason, _steps)
       ├─ stitchableStream (stream multiplexer)  [line 4905]
       ├─ experimental_transform (user transforms) [line 4942]
       ├─ createOutputTransformStream(output)     [line 4581]
       ├─ eventProcessor TransformStream          [line 4695]
       └─ baseStream → teeStream() → textStream / fullStream / partialOutputStream
            │
            └─ streamStep({ currentStep: 0 })    [line 4983]  ← 遞迴
```

#### Stage 1: streamText() 入口 [line 4513]

純 factory。設定預設值後委派給 `DefaultStreamTextResult`：
- `stopWhen = stepCountIs(1)` — 預設單步，不做 tool loop
- `includeRawChunks = false`
- 呼叫 `resolveLanguageModel(model)` 解析 model

**重要**：opencode 自己管 tool loop（`while(true)` 重複呼叫 `LLM.stream()`），所以 AI SDK 內建 tool loop 不被使用。但 AI SDK 的 schema validation、lifecycle events、stream transform 仍然全部在跑。

#### Stage 2: DefaultStreamTextResult 建構 [line 4646]

orchestration 層：
1. 建立 `stitchableStream` — 可動態接入新 inner stream 的 multiplexer
2. 接上 abort-aware reader wrapper
3. 套用 user-provided `experimental_transform`
4. 經過 `createOutputTransformStream` → `eventProcessor` 產生 `baseStream`
5. 開啟 telemetry span `"ai.streamText"`
6. 呼叫 `streamStep({ currentStep: 0 })`

#### Stage 3: streamStep() — 遞迴 step handler [line 4983]

每個 step（一次 model 呼叫）的流程：

**3a. Prompt 準備**
1. `standardizePrompt()` [line 1440] — 驗證 prompt/messages、Zod schema validation
2. 構建 `stepInputMessages` = initial messages + 前步 responseMessages
3. `prepareStep()` — 可覆蓋 model、system、messages、toolChoice
4. `convertToLanguageModelPrompt()` [line 913] — 下載 URL 資源、轉成 provider-level format
5. `prepareToolsAndToolChoice()` [line 1240] — 過濾 activeTools、轉成 `{type:"function",...}`

**3b. Model 呼叫**
6. `stepModel.doStream({...})` [line 5070] — 在 retry wrapper + telemetry span 裡呼叫

**3c. Tool 處理**
7. pipe through `runToolsTransformation()` [line 4266]

**3d. Step Transform Stream** [lines 5116-5363]

狀態累積：
- `stepToolCalls[]` — 所有 tool-call chunks
- `stepToolOutputs[]` — 所有 tool-result + tool-error
- `stepUsage`, `stepFinishReason`, `stepProviderMetadata`
- `activeText` — 串接的 text deltas

Chunk 轉換：
- `stream-start` → 消費（提取 warnings），不轉發
- `text-delta` → `delta` 改名為 `text`，過濾空值
- `reasoning-delta` → `delta` 改名為 `text`
- `response-metadata` → 更新 stepResponse
- `finish` → 捕獲 usage/finishReason/providerMetadata

**flush() — Step 續行邏輯** [line 5272]：
1. 發射 `finish-step`
2. 計算 `combinedUsage`
3. 等待 `stepFinish.promise`（由 eventProcessor 解決）
4. 過濾出 client-only tool calls/outputs
5. **續行條件**：`clientToolCalls.length > 0` AND 全有 outputs AND `!isStopConditionMet`
6. 滿足 → 推送 response messages，遞迴 `streamStep(currentStep+1)`
7. 不滿足 → 發射 `finish`，關閉 stream

#### Stage 4: runToolsTransformation() — Tool 執行引擎 [line 4266]

**雙 stream 合併架構**：
- `forwardStream` — TransformStream 處理 model 原始 stream
- `toolResultsStream` — 接收非同步 tool 執行結果

Tool call 處理流程：
1. `parseToolCall()` [line 1935] — schema validation + 可選 repair
2. 有效 → `tool.execute()` 在 telemetry span 裡執行
3. 無效 → `tool-error` 送入 toolResultsStream
4. `attemptClose()` — 等所有非同步 tool 完成才關閉 stream

#### Stage 5: parseToolCall() — 驗證/解析 [line 1935]

1. 查找 tool by name → `NoSuchToolError` if missing
2. `safeParseJSON({text, schema})` — 嚴格 schema validation
3. 失敗 + `repairToolCall` 存在 → 嘗試修復後重試
4. 全部失敗 → 回傳 `{...toolCall, invalid: true}` 標記

#### Stage 6: createOutputTransformStream() [line 4581]

- 無 output schema → pass-through，包裝成 `{part, partialOutput: undefined}`
- 有 output schema → 累積 text deltas、嘗試 incremental JSON parsing、發射 partial output

#### Stage 7: eventProcessor — 狀態追蹤 + lifecycle [line 4695]

**所有 chunks pass-through**，加上 side effects：

狀態追蹤：
- `activeTextContent{}` — per-ID text 累積
- `activeReasoningContent{}` — per-ID reasoning 累積
- `recordedContent[]` — 當前 step 所有 content parts
- `recordedSteps[]` — 所有完成的 steps

事件處理（關鍵）：
- `finish-step` [line 4801] → 建立 `DefaultStepResult`、呼叫 `onStepFinish`、**resolve stepFinish promise**
- `finish` [line 4827] → 記錄 totalUsage、finishReason
- `flush()` [line 4832] → resolve 所有 DelayedPromise、呼叫 `onFinish`、結束 telemetry span

### providerMetadata 流動路徑

Provider metadata 透過多個通道流過 pipeline：

| 來源 | 路徑 | 目的地 |
|------|------|--------|
| `model.doStream()` finish chunk | → `stepProviderMetadata` → `finish-step` | `DefaultStepResult.providerMetadata` |
| `text-start/delta/end` | → `activeTextContent[id].providerMetadata` | 累積在 text content |
| `tool-call` | → `parseToolCall()` 保留 | tool-call chunk |
| `reasoning-start/delta/end` | → `activeReasoningContent[id]` | reasoning content |
| Final step | → telemetry attribute `ai.response.providerMetadata` | observability |

**encrypted_content 路徑**：`@ai-sdk/openai` 在 SSE parse 時將 `encrypted_content` 放入 `reasoning-start` / `reasoning-end` 的 `providerMetadata` → eventProcessor 累積 → `recordedContent` → `DefaultStepResult`。

---

## @ai-sdk/openai Responses API Adapter 分析

### responses() Factory [line 4637]

`createOpenAI().responses(modelId)` 建立 `OpenAIResponsesLanguageModel`：
- `specificationVersion = "v2"` (LanguageModelV2)
- 預設入口：`provider(modelId)` 直接走 responses model（非 chat）

### Request Body 完整欄位表

`getArgs()` [line 3153] 構建的 body：

| 欄位 | 來源 | AI SDK 已處理 |
|------|------|:---:|
| `model` | `this.modelId` | ✅ |
| `input` | `convertToOpenAIResponsesInput()` | ✅ |
| `stream` | `true` (doStream) | ✅ |
| `temperature` | AI SDK standard param | ✅ |
| `top_p` | AI SDK standard param | ✅ |
| `max_output_tokens` | AI SDK `maxOutputTokens` | ✅ |
| `instructions` | `providerOptions.openai.instructions` | ✅ |
| `store` | `providerOptions.openai.store` | ✅ |
| `include` | auto-composed + `providerOptions.openai.include` | ✅ |
| `service_tier` | `providerOptions.openai.serviceTier` | ✅ |
| `prompt_cache_key` | `providerOptions.openai.promptCacheKey` | ✅ |
| `prompt_cache_retention` | `providerOptions.openai.promptCacheRetention` | ✅ |
| `previous_response_id` | `providerOptions.openai.previousResponseId` | ✅ |
| `reasoning` | conditional (effort + summary) | ✅ |
| `tools` / `tool_choice` | `prepareResponsesTools()` | ✅ |
| `text` | conditional (json format + verbosity) | ✅ |
| `conversation` | `providerOptions.openai.conversation` | ✅ |
| `metadata` | `providerOptions.openai.metadata` | ✅ |
| `user` | `providerOptions.openai.user` | ✅ |
| `parallel_tool_calls` | `providerOptions.openai.parallelToolCalls` | ✅ |
| `max_tool_calls` | `providerOptions.openai.maxToolCalls` | ✅ |
| `truncation` | `providerOptions.openai.truncation` | ✅ |
| `top_logprobs` | derived from `providerOptions.openai.logprobs` | ✅ |
| `safety_identifier` | `providerOptions.openai.safetyIdentifier` | ✅ |
| **`context_management`** | — | ❌ 不存在 |

### include 自動組合邏輯 [lines 3213-3242]

Adapter 自動加入的 `include` 值：
- `"message.output_text.logprobs"` — 當 logprobs 啟用
- `"web_search_call.action.sources"` — 當有 web_search tool
- `"code_interpreter_call.outputs"` — 當有 code_interpreter tool
- **`"reasoning.encrypted_content"`** — 當 `store === false` AND 是 reasoning model

使用者可透過 `providerOptions.openai.include` 額外傳入，限定 enum：
`["reasoning.encrypted_content", "file_search_call.results", "message.output_text.logprobs"]`

### SSE Response Parse — 關鍵事件對照

| SSE Event | → LanguageModelV2StreamPart | providerMetadata |
|---|---|---|
| `response.created` | `response-metadata` (id, created_at, model) | — |
| `response.output_item.added` (message) | `text-start` | `itemId` |
| `response.output_item.added` (reasoning) | `reasoning-start` | **`encrypted_content`**, `itemId` |
| `response.output_item.added` (function_call) | `tool-input-start` | `itemId` |
| `response.output_text.delta` | `text-delta` | logprobs |
| `response.function_call_arguments.delta` | `tool-input-delta` | — |
| `response.output_item.done` (function_call) | `tool-input-end` + `tool-call` | `itemId` |
| `response.output_item.done` (message) | `text-end` | annotations |
| `response.output_item.done` (reasoning) | `reasoning-end` | **`encrypted_content`** |
| `response.completed` / `response.incomplete` | → `finish` (in flush) | `responseId`, `serviceTier`, logprobs |

### Prompt 轉換 (convertToOpenAIResponsesInput) [lines 2108-2377]

| AI SDK Role | → Responses API Format |
|---|---|
| `system` | `{role: "system"}` or `{role: "developer"}` (per model capabilities) |
| `user` text | `{role: "user", content: [{type: "input_text", text}]}` |
| `user` file (image) | `{type: "input_image", image_url}` or `{file_id}` |
| `user` file (PDF) | `{type: "input_file", file_url}` or `{file_data: base64}` |
| `assistant` text | store+id → `{type: "item_reference", id}`; else → `{role: "assistant", content: [{type: "output_text", text}]}` |
| `assistant` tool-call | `{type: "function_call", call_id, name, arguments}` or `{type: "item_reference", id}` |
| `assistant` reasoning | `{type: "reasoning", id, encrypted_content, summary: [{type: "summary_text", text}]}` |
| `tool` result | `{type: "function_call_output", call_id, output}` |

### Custom Fetch 切入點

```
createOpenAI({ fetch: customFetch })
  → config.fetch
    → OpenAIResponsesLanguageModel.doStream()
      → postJsonToApi({ fetch: this.config.fetch })
        → customFetch(url, { body, headers })
```

Custom fetch 攔截在 **HTTP 層** — 收到完整構建的 URL、headers、JSON body。可以：
- 讀寫 request body（加欄位）
- 讀寫 headers
- 改寫 URL
- 處理 response

---

## codex.ts Fetch Interceptor 現有能力盤點

### CodexNativeAuthPlugin（`codex` provider 用）

**Auth 操作**：
- 移除 dummy API key Authorization header
- Token refresh（過期時自動 refresh）
- 設定 `Bearer ${access_token}`
- 設定 `ChatGPT-Account-Id` header

**URL Rewrite**：
- 偵測 `/v1/responses`、`/chat/completions`、`/codex/responses` → 重寫到 `chatgpt.com/backend-api/codex/responses`

**Body Transform**：
- `instructions` — 從 system/developer message 提取或 fallback "You are a helpful assistant."
- `delete max_output_tokens` / `delete max_tokens` — codex 不支援
- `prompt_cache_key` — 注入 session-stable cache key（如果 body 沒有）

**Header 操作**：
- `x-codex-turn-state` — 從 response 捕獲、在下次 request replay
- `originator: "opencode"` (chat.headers hook)
- `User-Agent` (chat.headers hook)
- `session_id` (chat.headers hook)

**Response 處理**：
- 捕獲 `x-codex-turn-state` response header → 存入 module-level state

### CodexAuthPlugin（`openai` provider 用）

較簡化版，差異：
- 沒有 prompt_cache_key 注入
- 沒有 turn state 管理
- body transform 類似（instructions, delete max_output_tokens）

---

## 7 個 Codex Component 的 Integration Point 對照

| # | Component | 說明 | AI SDK 支援度 | 整合方式 |
|---|---|---|---|---|
| 1 | **prompt_cache_key** | Server-side prefix caching key | ✅ `providerOptions.openai.promptCacheKey` | **可從 fetch interceptor 搬到 providerOptions**。目前 interceptor 在 body 沒有時補上，但 AI SDK adapter 已原生支援。應改為在 `LLM.stream()` 呼叫時透過 providerOptions 傳入，interceptor 只做 fallback。 |
| 2 | **turn_state** | Sticky routing token (x-codex-turn-state header) | ❌ 不在 AI SDK body 構建 | **保留在 fetch interceptor**。Header-level 操作，不影響 body。Response header capture + request header replay。 |
| 3 | **context_management** | Inline compaction (compact_threshold) | ❌ 完全不存在於 AI SDK | **必須在 fetch interceptor body transform 加入**。`body.context_management = [{type: "compaction", compact_threshold: N}]` |
| 4 | **encrypted_content** | Reasoning encrypted content (include + history preservation) | ✅ 自動加入 `include` 當 `store=false` + reasoning model | **透過 providerOptions 設定 `store: false`**。AI SDK adapter 自動處理 include。SSE parse 已保留 encrypted_content 到 providerMetadata。Session 層需確認 history replay 時保留。 |
| 5 | **store** | 控制是否存到 OpenAI 伺服器 | ✅ `providerOptions.openai.store` | **透過 providerOptions 設定**。目前 interceptor 未處理此欄位。 |
| 6 | **service_tier** | Priority/flex service tier | ✅ `providerOptions.openai.serviceTier` | **透過 providerOptions 設定**。支援 "auto"、"flex"、"priority"、"default"。Adapter 會根據 model 能力過濾。 |
| 7 | **compaction** (via context_management) | 與 #3 相同 — server-side context compaction | ❌ | 同 #3 |

### 整合策略總結

```
┌──────────────────────────────────────────────────────┐
│ LLM.stream() 呼叫                                    │
│  providerOptions.openai = {                          │
│    promptCacheKey: "...",     ← #1 搬到這裡           │
│    store: false,             ← #5 新增               │
│    serviceTier: "priority",  ← #6 新增               │
│    include: ["reasoning.encrypted_content"],  ← #4   │
│  }                                                   │
└──────────────────────┬───────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────┐
│ @ai-sdk/openai responses adapter                     │
│  → 構建 request body（含上述所有欄位）                  │
│  → fetch(url, { body, headers })                     │
└──────────────────────┬───────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────┐
│ codex.ts fetch interceptor                           │
│  ✦ Auth (Bearer token, Account-Id)                   │
│  ✦ URL rewrite → codex endpoint                      │
│  ✦ Header: x-codex-turn-state replay       ← #2     │
│  ✦ Body: context_management injection       ← #3/#7  │
│  ✦ Body: delete max_output_tokens                    │
│  ✦ Body: instructions extraction                     │
│  ✦ Response: capture x-codex-turn-state     ← #2    │
└──────────────────────────────────────────────────────┘
```

---

## Decisions

### DD-1: 不取代 AI SDK，在 fetch interceptor 層加 Responses API 功能

**Decision**: 所有 codex 進階功能透過 `providerOptions` + custom fetch interceptor 實作。不用 CUSTOM_LOADER。

**Rationale**: AI SDK `@ai-sdk/openai` responses adapter 已原生支援 prompt_cache_key、store、service_tier、include、reasoning 等 17+ 個 Responses API 欄位。只有 `context_management` 需要 fetch interceptor 補。保留 AI SDK 的全部 pipeline 功能。

### DD-2: CodexLanguageModel / codex-websocket.ts 廢棄

**Decision**: 停用 CUSTOM_LOADER。

**Rationale**:
- WebSocket transport 的唯一優勢是省 TCP handshake（~50ms），但帶來併發隔離、handler 管理、stream lifecycle 等大量問題
- `@ai-sdk/openai` 的 responses adapter 已能正確構建 request body
- 保留程式碼作為參考

### DD-3: 功能分層 — providerOptions vs fetch interceptor

**Decision**: 功能應盡量透過 `providerOptions.openai.*` 傳入，讓 AI SDK adapter 正式構建 body。Fetch interceptor 只處理三類操作：

1. **Auth** — OAuth token、Account-Id header
2. **Transport** — URL rewrite、turn state header、delete 不支援的欄位
3. **AI SDK 缺口** — `context_management`（唯一需要 additive body transform 的功能）

**Rationale**: 透過 providerOptions 傳入的欄位會經過 AI SDK 的型別檢查和 model capability 過濾（例如 service_tier 在不支援的 model 上會被刪除）。Fetch interceptor 的 additive transform 繞過了這些保護。

### DD-4: encrypted_content 透過 AI SDK 自動處理

**Decision**: 設定 `providerOptions.openai.store = false`，AI SDK adapter 會自動在 `include` 加入 `"reasoning.encrypted_content"`。不需要在 fetch interceptor 另外處理。

**Rationale**: AI SDK 的 auto-compose 邏輯 [lines 3213-3242] 已正確處理。SSE parser 已將 encrypted_content 放入 providerMetadata。Session 層需確認 history replay 時將 encrypted_content 放回 assistant reasoning messages。

---

## Risks / Trade-offs

- **R1: ~~@ai-sdk/openai 的 request body 可能不包含某些欄位~~** → **已驗證**：AI SDK 支援 17+ 個 Responses API 欄位。唯一缺口是 `context_management`。
- **R2: AI SDK 版本升級可能改變 body 格式** — Mitigation: fetch interceptor 做 additive transform，不改已有欄位
- **R3: encrypted reasoning content 需要在 history 中保留** — AI SDK SSE parser 已保留 encrypted_content 到 providerMetadata。需確認 session 層在 history replay 時將 `{type: "reasoning", encrypted_content, summary}` 正確傳回。
- **R4: prompt_cache_key 雙重注入** — 目前 interceptor 和 AI SDK adapter 都可能設定此欄位。搬遷時需確保不重複。
- **R5: instructions 雙重處理** — AI SDK adapter 透過 `providerOptions.openai.instructions` 處理，interceptor 也從 system message 提取。需統一。

---

## Critical Files

- `packages/opencode/src/plugin/codex.ts` — fetch interceptor（主要修改點）
- `packages/opencode/src/provider/provider.ts` — CUSTOM_LOADER 停用、providerOptions 傳入
- `packages/opencode/src/provider/codex-language-model.ts` — 廢棄（保留程式碼）
- `packages/opencode/src/provider/codex-websocket.ts` — 廢棄（保留程式碼）
- `packages/opencode/src/session/llm.ts` — providerOptions 注入點（LLM.stream 呼叫處）
- `node_modules/@ai-sdk/openai/dist/index.js` — 參考：responses adapter body 構建
- `node_modules/ai/dist/index.js` — 參考：streamText pipeline
