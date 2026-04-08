# AI SDK Layer Decomposition — Codex Provider Datasheet

## Purpose

分析 AI SDK 在 Codex provider 路徑中的功能層級，識別可復用 vs 不可復用部份，
為 native codex provider 提供正確的架構決策依據。

## Source Files

- `node_modules/ai/dist/index.js` — streamText, tool execution, stream processing
- `node_modules/@ai-sdk/provider/dist/index.d.ts` — LanguageModelV2 types, StreamPart types
- `packages/opencode/src/provider/sdk/copilot/responses/openai-responses-language-model.ts` — Responses API adapter
- `packages/opencode/src/session/llm.ts` — streamText call site

---

## AI SDK 功能層級

### Layer 1: Transport (可替換)

| 功能 | 說明 | 可復用 |
|---|---|---|
| HTTP fetch | 發送 request, 接收 SSE response | **可替換** — native provider 自己 fetch |
| Headers | Authorization, User-Agent, custom headers | **可替換** — native provider 自己建 |
| URL routing | Endpoint selection | **可替換** |

### Layer 2: Request Serialization (可復用)

| 功能 | 說明 | 可復用 |
|---|---|---|
| Prompt → messages | `convertToModelMessages()` | **可復用** — AI SDK 統一格式 |
| Tool schema → tools | Tool JSON schema serialization | **可復用** — AI SDK 統一格式 |
| Provider options | reasoning, text, include, service_tier | **可復用** |

### Layer 3: SSE Event Parsing (關鍵層)

| 功能 | 說明 | 可復用 |
|---|---|---|
| SSE line parser | `data: {json}\n\n` → JSON objects | **可復用** — 標準 SSE 格式 |
| Responses API event mapping | JSON events → LanguageModelV2StreamPart | **不可復用** — 這是 adapter 的核心 |
| Tool call assembly | output_item.added → delta → done → tool-call | **不可復用** — 關鍵 contract |
| Text streaming | output_text.delta → text-delta | **不可復用** — event mapping |
| Usage extraction | response.completed → usage | **不可復用** |

### Layer 4: Stream Part Contract (必須遵守)

| Stream Part | 必須? | 觸發 | 用途 |
|---|---|---|---|
| `tool-input-start` | 否 | — | UI streaming 開始 |
| `tool-input-delta` | 否 | — | UI streaming 進度 |
| `tool-input-end` | 否 | — | UI streaming 結束 |
| **`tool-call`** | **是** | **Tool execution** | **AI SDK 唯一的 execution trigger** |
| `tool-result` | 條件 | — | Provider-executed tool 的結果 |
| `text-start` | 否 | — | Text streaming |
| `text-delta` | 否 | — | Text content |
| `text-end` | 否 | — | Text complete |
| `reasoning-*` | 否 | — | Reasoning content |
| `finish` | 是 | Turn end | Usage + finish reason |

### Layer 5: Tool Execution (不可替換)

| 功能 | 說明 | 可復用 |
|---|---|---|
| `streamText()` | Orchestrates model call + tool loop | **不可替換** — 核心 loop |
| `executeTools()` | Dispatches tool-call to registered tools | **不可替換** |
| `parseToolCall()` | Validates tool-call input against schema | **不可替換** |
| Tool result → next turn | Feeds tool output back as input | **不可替換** |

---

## Tool Call 完整流程（必須遵守的 Contract）

### 1. Server 端事件序列（Responses API）

```
response.output_item.added   { item: { type: "function_call", call_id, name } }
response.function_call_arguments.delta  { delta: "..." }  (可能多個)
response.function_call_arguments.done   { arguments: "..." }
response.output_item.done    { item: { type: "function_call", call_id, name, arguments: "完整JSON" } }
```

**注意**：streaming delta 可能被 obfuscated（`delta="{}"`），但 `output_item.done` 的 `item.arguments` 包含真正的完整 arguments。

### 2. Adapter 必須 emit 的 Stream Parts

```
tool-input-start  { id: call_id, toolName }           ← UI 用
tool-input-delta  { id: call_id, delta }               ← UI 用（可選）
tool-input-end    { id: call_id }                      ← UI 用
tool-call         { toolCallId: call_id, toolName,     ← AI SDK 用（**必須**）
                    input: "完整JSON字串" }
```

**`tool-call` 是觸發 tool execution 的唯一機制。** 不 emit `tool-call` = tool 不會被執行。

### 3. AI SDK 內部處理

```
streamText()
  ├── 收集 content 中所有 type === "tool-call" 的 parts
  ├── parseToolCall() — 驗證 input 是否符合 tool schema
  ├── executeTools() — 呼叫 tool.execute(input)
  └── 將 tool result 加入 messages，繼續下一輪
```

---

## 舊 Adapter 正確做法（Line 960-980）

```typescript
// 在 response.output_item.done 時：
controller.enqueue({ type: "tool-input-end", id: item.call_id })
controller.enqueue({
  type: "tool-call",
  toolCallId: item.call_id,
  toolName: item.name,
  input: item.arguments,    // ← 從 output_item.done 的完整 item 取
})
```

**為什麼兩個都要 emit？**
- `tool-input-end` 通知 UI streaming 結束
- `tool-call` 觸發 AI SDK 的 tool execution

**為什麼從 `output_item.done` 取 arguments 而非 streaming delta？**
- Streaming delta 可能被 obfuscated（server 行為）
- `output_item.done` 的 item 包含最終的、完整的 arguments

---

## 新 Provider 的問題診斷

| 問題 | 原因 | 修復 |
|---|---|---|
| Tool 不被執行 | 只 emit `tool-input-end`，缺少 `tool-call` | Emit `tool-call` from `output_item.done` |
| Tool input 為空 `{}` | 從 streaming delta 取 arguments（被 obfuscated） | 改從 `output_item.done` 的 `item.arguments` 取 |
| 靜默停止 | Tool abort 後 AI SDK 結束 turn，沒有 retry | Tool 正常後自然解決 |

---

## 架構決策

### 可復用（保留 AI SDK）

1. **streamText()** — tool execution loop, 不可替換
2. **LanguageModelV2 interface** — provider contract, 不可替換
3. **Prompt serialization** — messages + tools, 可復用
4. **Provider options** — reasoning/text/include, 可復用

### 不可復用（必須自己實作）

1. **SSE event → StreamPart mapping** — Responses API 特有，但必須遵守 tool-call contract
2. **Transport** — WS/HTTP，自己的 identity headers
3. **Continuation** — previous_response_id, input delta

### 可以復用但目前沒用的

1. **`openai-responses-language-model.ts`** — 舊 adapter 已經正確處理所有 edge case
   - 如果能把它抽成 shared utility（不綁定 `@ai-sdk/openai`），native provider 可以委託給它做 event → StreamPart mapping
   - 這樣 native provider 只需要負責 transport + identity，event parsing 交給已驗證的代碼

---

## 結論

native provider 的 `sse.ts` 需要做的**最小修復**：

在 `response.output_item.done` 事件處理中，emit `tool-call` stream part，
`input` 欄位從 `event.item.arguments` 取值（不從 streaming delta 取）。

這等同於舊 adapter line 970-980 的行為。其他所有 stream part 保持不變。
