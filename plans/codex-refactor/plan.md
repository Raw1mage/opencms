# Codex Provider Refactor — 單一計畫書

版本：2026-04-09
狀態：施工中（Phase 4 實作 + hotfix 迭代）

---

## 一、背景

Codex provider 散布在 opencode core 的多個檔案中（codex.ts 960 行、codex-websocket.ts 653 行、codex-native.ts 318 行、provider.ts 中的 model 定義、compaction.ts 中的特殊路徑），透過 fetch interceptor hack 注入 protocol 行為。需重構為獨立的 `@opencode-ai/codex-provider` package。

### 前置修復（已完成 2026-04-08）

compact_threshold 從硬編碼 100K 改為動態計算（model context * 80%）。SessionSnapshot 廢除，compaction 改用 SharedContext。已 merge 到 main。

---

## 二、需求

1. Codex provider 重構為獨立 package（`packages/opencode-codex-provider/`）
2. 實作 `LanguageModelV2` interface，直接對接 Responses API
3. 保持與舊 provider 完全相同的 request fingerprint
4. WS transport + delta + continuation 在 package 內部完成
5. opencode 主程式零 codex 硬編碼

### 已 dropped

- HTTP delta（upstream 不支援 `previous_response_id` over HTTP）

---

## 三、Datasheet（Protocol 規格）

### 3.1 Request Body（WS mode）

Golden reference: `golden-request.json`

```
type:               "response.create"
model:              "gpt-5.4"
instructions:       "You are a helpful assistant."     ← 固定 placeholder
store:              false
service_tier:       "priority"
tool_choice:        "auto"
reasoning:          { effort: "medium", summary: "auto" }
text:               { verbosity: "low" }               ← 僅非 codex 型號
include:            ["reasoning.encrypted_content"]     ← 僅 opencode provider
prompt_cache_key:   "ses_{sessionID}"
context_management: [{ type: "compaction", compact_threshold: N }]
input:              ResponseItem[]                      ← 見 §3.2
tools:              FunctionTool[]                      ← 見 §3.3
```

**WS 不送的 fields**：`stream`, `parallel_tool_calls`, `max_tokens`, `temperature`

### 3.2 Input Items 格式

| 位置 | type/role | content 格式 | 說明 |
|---|---|---|---|
| `[0]` | `role: "developer"` | string (31K+ chars) | **完整 system prompt**。不是放 instructions。 |
| `[1+]` | `role: "user"` | `[{type:"input_text", text}]` | **一律 content parts array**，不用 string |
| | `role: "assistant"` | `[{type:"output_text", text}]` | **一律 content parts array**，type 是 output_text |
| | `type: "function_call"` | `{call_id, name, arguments: "JSON字串"}` | AI 發起的 tool call |
| | `type: "function_call_output"` | `{call_id, output: [{type:"input_text", text:"..."}]}` | **tool 結果是 content parts array，不是字串** |

### 3.3 Tool Schema

```json
{
  "type": "function",
  "name": "bash",
  "description": "...",
  "parameters": { "type": "object", ... },
  "strict": false
}
```

### 3.4 Response Event → StreamPart 映射

| Server Event | Emit StreamPart | 備註 |
|---|---|---|
| `output_item.added` (message) | `text-start` | |
| `output_text.delta` | `text-delta` | |
| `output_text.done` | `text-end` | |
| `output_item.added` (function_call) | `tool-input-start` | |
| `function_call_arguments.delta` | `tool-input-delta` | **可能被 obfuscated，不可依賴** |
| **`output_item.done` (function_call)** | **`tool-input-end` + `tool-call`** | **tool-call 是唯一 execution trigger。arguments 從此事件的 item.arguments 取。** |
| `reasoning_summary_text.delta` | `reasoning-start` + `reasoning-delta` | |
| `reasoning_summary_text.done` | `reasoning-end` | |
| `response.completed` | `finish` | usage 含 `cachedInputTokens`, `reasoningTokens` |

### 3.5 providerOptions 映射

| camelCase option | API field | 值 | 來源 |
|---|---|---|---|
| `store` | `store` | `false` | `ProviderTransform.options()` 需加 codex 判斷 |
| `promptCacheKey` | `prompt_cache_key` | sessionID | 固定 |
| `serviceTier` | `service_tier` | `"priority"` | codex 專用 |
| `reasoningEffort` | `reasoning.effort` | `"medium"` | gpt-5.x |
| `reasoningSummary` | `reasoning.summary` | `"auto"` | gpt-5.x |
| `textVerbosity` | `text.verbosity` | `"low"` | gpt-5.x 非 codex 型號 |

讀取路徑：`callOptions.providerOptions.codex.{key}` → fallback `callOptions.providerOptions.{key}`

---

## 四、已知陷阱

| 陷阱 | 後果 | 正確做法 |
|---|---|---|
| System prompt 放 `instructions` | AI 沒有 context，回覆一句話就停 | 放 `input[0]` developer role |
| Tool result 用 `JSON.stringify()` | AI 看到空內容 | Array output 直接傳 |
| 只 emit `tool-input-end` | Tool 不執行 | 必須 emit `tool-call`（從 `output_item.done` 取 args） |
| 從 streaming delta 取 arguments | 被 obfuscated 得到 `"{}"` | 從 `output_item.done` 的 `item.arguments` 取 |
| 缺 `reasoning`/`store`/`service_tier` | Server 降級回應 | 從 providerOptions pipeline 完整映射 |
| Tool schema 缺 `strict: false` | Schema validation 差異 | 加上 |
| WS mode 送 `stream: true` | 舊 adapter 不送 | 只在 HTTP path 送 |

---

## 五、Package 結構

```
packages/opencode-codex-provider/src/
├── protocol.ts      — 常數（URL, originator, timeout）
├── types.ts         — ResponsesApiRequest, ResponseStreamEvent, CodexCredentials
├── convert.ts       — AI SDK prompt → instructions + input[]（§3.2 格式）
├── headers.ts       — HTTP/WS headers builder
├── auth.ts          — OAuth PKCE + token refresh
├── sse.ts           — Response events → LanguageModelV2StreamPart（§3.4 映射）
├── models.ts        — Model catalog + compact_threshold
├── continuation.ts  — File-backed WS continuation state
├── transport-ws.ts  — WS transport + delta + first-frame probe
├── provider.ts      — CodexLanguageModel（LanguageModelV2 實作）
└── index.ts         — Public exports
```

### 整合點

| 檔案 | 修改 |
|---|---|
| `custom-loaders-def.ts` | codex loader 呼叫 `createCodex()` |
| `plugin/codex-auth.ts` | Thin auth plugin（OAuth only，無 fetch interceptor） |
| `plugin/index.ts` | Import `CodexNativeAuthPlugin` from `codex-auth.ts` |
| `provider/provider.ts` | Model npm 改為 `@opencode-ai/codex-provider` |
| `provider/transform.ts` | `store=false` 判斷加入 codex providerId |
| `session/llm.ts` | 送 `session_id` header 給 codex provider |

---

## 六、驗證方法

1. **Golden diff**：新 provider 的 WS request body 必須與 `golden-request.json` 的 top-level fields 完全匹配
2. **Tool call**：開新 session，要求 AI 讀檔 → 必須完整回報內容
3. **Multi-turn**：3+ 輪對話含 tool call → 全部正常完成
4. **WS delta**：R2+ 的 `inputItems < fullItems` → delta mode 生效
5. **Cache hit**：R2+ 的 `cacheReadTokens > 0`
6. **Abort zero**：整個 session 無 `Tool execution aborted`

---

## 七、Revision History

| 日期 | 事件 |
|---|---|
| 2026-04-08 | 初始需求（quota 調查 → compact_threshold fix → codex refactor plan） |
| 2026-04-08 | Upstream delta 分析（30+ commits, originator 架構變更） |
| 2026-04-08 | Beta workflow: native provider package 實作 + merge to main |
| 2026-04-08 | Hotfix: session context wiring, cache reporting, tool call_id |
| 2026-04-08~09 | Hotfix: tool-call stream part, tool result format, system prompt placement |
| 2026-04-09 | Hotfix: providerOptions pipeline（reasoning, store, service_tier） |
| 2026-04-09 | 計畫整併：compaction-hotfix + specs/codex + codex-refactor → 單一 plan |
| 2026-04-09 | Datasheet 建立：golden-request.json + field-level 規格 |
