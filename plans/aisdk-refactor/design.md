# Design

## Context

codex provider 目前有兩條路徑：
1. **AI SDK path**（正常運作）：`sdk.responses(modelId)` → custom fetch interceptor → HTTP SSE
2. **CUSTOM_LOADER path**（已停用）：`CodexLanguageModel.doStream()` → WebSocket/C binary

CUSTOM_LOADER 試圖取代 AI SDK 的整個 stream pipeline，但缺少大量功能導致 tool call、lifecycle、併發全部壞掉。

## AI SDK 架構分析

### 程式碼分佈

| Package | 行數 | 檔案 | 職責 |
|---------|------|------|------|
| `ai` (core) | 11,436 | `node_modules/ai/dist/index.js` | streamText、tool loop、eventProcessor、fullStream |
| `@ai-sdk/openai` | 9,219 | `node_modules/@ai-sdk/openai/dist/index.js` | Responses API model adapter |
| `@ai-sdk/provider-utils` | 2,850 | `node_modules/@ai-sdk/provider-utils/dist/index.js` | schema validation、JSON parse |
| `@ai-sdk/openai-compatible` | 1,647 | `node_modules/@ai-sdk/openai-compatible/dist/index.js` | 通用 OpenAI adapter |
| `@ai-sdk/provider` | 420 | `node_modules/@ai-sdk/provider/dist/index.d.ts` | LanguageModelV2 interface |

### streamText 內部 pipeline

```
streamText(options)
  │
  ├─ standardizePrompt()          — prompt 格式標準化
  │
  ├─ streamStep()                 — 遞迴 step 處理
  │    │
  │    ├─ model.doStream(options)  — 呼叫 LanguageModelV2
  │    │    └─ 回傳 ReadableStream<LanguageModelV2StreamPart>
  │    │
  │    ├─ runToolsTransformation() — tool call 偵測/parse/validate/execute
  │    │    ├─ tool-input-start/delta/end → 重組成 tool-call
  │    │    ├─ parseToolCall() → schema validation
  │    │    ├─ tool.execute() → 執行 tool function
  │    │    └─ tool-result → 收集結果
  │    │
  │    ├─ createOutputTransformStream() — 包裝成 { part, partialOutput }
  │    │
  │    └─ eventProcessor — 狀態追蹤 + lifecycle events
  │         ├─ text-start → 建立 activeTextContent[id]
  │         ├─ text-delta → 累加 text
  │         ├─ text-end → 清除 active
  │         ├─ tool-call → 記錄 stepToolCalls
  │         ├─ tool-result → 記錄 stepToolOutputs
  │         └─ finish → 記錄 usage/finishReason
  │
  ├─ flush() — step 結束後決策
  │    ├─ clientToolCalls.length > 0 && all have outputs?
  │    │    └─ YES + !isStopConditionMet → streamStep(currentStep+1)
  │    └─ NO → controller.enqueue(finish) + closeStream()
  │
  └─ baseStream → fullStream (供 processor for-await 消費)
```

### tool loop 機制

- **預設 `stopWhen = stepCountIs(1)`** — 只跑 1 step，不做 tool loop
- opencode 的 processor 自己管 tool loop — `while(true)` 重複呼叫 `LLM.stream()`
- 所以 AI SDK 的內建 tool loop 不被使用，但 AI SDK 的其他功能（schema validation、lifecycle events、stream transform）仍然在跑

### @ai-sdk/openai 的 Responses API 支援

`sdk.responses(modelId)` 回傳的 model 已經：
- 把 AI SDK prompt → Responses API input items（跟我的 `promptToRequestBody` 做同樣的事）
- 處理 `instructions` 頂層欄位
- 處理 tool 序列化
- parse SSE events → LanguageModelV2StreamPart
- 處理 usage、finishReason mapping

### custom fetch interceptor 的切入點

Plugin 的 custom fetch 在 AI SDK 發 HTTP request **之前**攔截：

```
AI SDK model.doStream()
  → 構建 request body（@ai-sdk/openai 做）
  → fetch(url, { body, headers })
      ↓
  plugin custom fetch 攔截
      ├─ auth injection（Authorization、ChatGPT-Account-Id）
      ├─ URL rewrite（→ chatgpt.com/backend-api/codex/responses）
      ├─ body transform（prompt_cache_key、turn_state、instructions）
      └─ response capture（x-codex-turn-state header）
```

## Decisions

### DD-1: 不取代 AI SDK，在 fetch interceptor 層加 Responses API 功能

**Decision**: 所有 codex 進階功能（cache key、context_management、encrypted reasoning、compaction）透過 custom fetch interceptor 的 body transform 實作。不用 CUSTOM_LOADER。

**Rationale**: AI SDK 的 `@ai-sdk/openai` responses adapter 已經做了 prompt → Responses API 的轉換。我們只需要在 fetch 層加入額外欄位。這樣保留 AI SDK 的全部 25,000 行功能（tool loop、validation、lifecycle），不需要重新實作。

### DD-2: CodexLanguageModel / codex-websocket.ts 廢棄

**Decision**: 停用 CUSTOM_LOADER。CodexLanguageModel、codex-websocket.ts、C binary transport 的程式碼保留但不使用。

**Rationale**:
- WebSocket transport 的唯一優勢是省 TCP handshake（~50ms），但帶來了併發隔離、handler 管理、stream lifecycle 等大量問題
- C binary 的優勢是 wire format 精確，但 `@ai-sdk/openai` 的 responses adapter 已經能正確構建 request body
- 保留程式碼作為參考，未來如果 AI SDK 不滿足需求可以重新啟用

### DD-3: Responses API 功能在 fetch body transform 實作

**Decision**: 以下功能在 plugin codex.ts 的 custom fetch interceptor 裡實作：

| 功能 | 實作方式 |
|------|---------|
| prompt_cache_key | ✅ 已有 — body.prompt_cache_key |
| x-codex-turn-state | ✅ 已有 — header capture/replay |
| context_management (inline compaction) | body.context_management = [{type:"compaction", compact_threshold: N}] |
| encrypted_content | body.include = ["reasoning.encrypted_content"] + preserve in history |
| store: false | body.store = false |
| service_tier | body.service_tier = "priority" |

## Risks / Trade-offs

- **R1: @ai-sdk/openai 的 request body 可能不包含某些 Responses API 欄位** — 需要驗證 `sdk.responses()` 構建的 body 是否已包含 `include`、`store` 等欄位。如果沒有，在 fetch interceptor 補上。
- **R2: AI SDK 版本升級可能改變 body 格式** — Mitigation: fetch interceptor 做 additive transform（加欄位），不改已有欄位
- **R3: encrypted reasoning content 需要在 conversation history 中保留** — 這是 session 層的事，不是 transport 層。需要確認 AI SDK 的 response parse 有保留 encrypted_content

## Critical Files

- `packages/opencode/src/plugin/codex.ts` — fetch interceptor（主要修改點）
- `packages/opencode/src/provider/provider.ts` — CUSTOM_LOADER 停用
- `packages/opencode/src/provider/codex-language-model.ts` — 廢棄（保留程式碼）
- `packages/opencode/src/provider/codex-websocket.ts` — 廢棄（保留程式碼）
- `node_modules/@ai-sdk/openai/dist/index.js` — 參考：responses adapter 怎麼構建 body
- `node_modules/ai/dist/index.js` — 參考：streamText pipeline
