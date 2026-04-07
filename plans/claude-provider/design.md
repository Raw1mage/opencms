# Design (v3)

> v1: C11 native plugin (abandoned — official CLI is JS)
> v2: Hook-based refactor of anthropic.ts (superseded — SDK still pollutes)
> v3: Replace @ai-sdk/anthropic with native LanguageModelV2 implementation
> Updated: 2026-04-07

---

## Problem Statement

```
                    ┌── @ai-sdk/anthropic ──┐
                    │  anthropic-client: ✗   │
streamText() ──►   │  x-api-key: ✗          │  ──► plugin fetch (scrub) ──► wire
  (clean)          │  User-Agent: ✗         │        ↑ 在這裡擦屁股
                    │  body serialize: ✗     │
                    └────────────────────────┘
```

Plugin 在最後一關 scrub SDK 注入的髒 header，但：
- Scrub list 需手動維護，SDK 升級可能引入新污染
- Body 已被 SDK serialize，plugin 必須 parse→modify→re-serialize
- SDK 的 request builder 決定了 body 結構，plugin 無法控制

**根本解法**：不用 `@ai-sdk/anthropic`，自己實作 `LanguageModelV2`。

---

## AI SDK 分層架構

```
┌─────────────────────────────────────────────────────────┐
│  Layer A: Orchestration            package: 'ai'        │
│  streamText(), generateText()                           │
│  tool loop, retry, abort, telemetry                     │
│  ➜ 完全不碰 HTTP，透過 LanguageModelV2 interface 呼叫   │
│  ➜ 保留 ✅                                              │
├─────────────────────────────────────────────────────────┤
│  Layer B: Type System              package: '@ai-sdk/provider' │
│  LanguageModelV2, LanguageModelV2CallOptions             │
│  LanguageModelV2StreamPart, LanguageModelV2Middleware     │
│  ➜ 純型別定義，零 runtime                               │
│  ➜ 保留 ✅                                              │
├─────────────────────────────────────────────────────────┤
│  Layer C: Middleware               package: 'ai'        │
│  wrapLanguageModel(), transformParams()                  │
│  ➜ 不碰 HTTP，攔截 LanguageModelV2CallOptions           │
│  ➜ 保留 ✅                                              │
╞═════════════════════════════════════════════════════════╡
│              ↑ KEEP ABOVE / REPLACE BELOW ↑             │
╞═════════════════════════════════════════════════════════╡
│  Layer D: @ai-sdk/anthropic        ← 整層替換 ❌        │
│  D1: createAnthropic() — header 注入 (anthropic-client) │
│  D2: getArgs() — body serialize (messages/tools format)  │
│  D3: postJsonToApi() — HTTP fetch execution              │
│  D4: SSE parser — response stream → StreamPart           │
│  ➜ 替換為 opencode-claude-provider                      │
└─────────────────────────────────────────────────────────┘
```

### Protocol Boundary: LanguageModelV2

```typescript
interface LanguageModelV2 {
  specificationVersion: 'v2'
  provider: string
  modelId: string

  doGenerate(options: LanguageModelV2CallOptions): Promise<{
    content: LanguageModelV2Content[]
    finishReason: LanguageModelV2FinishReason
    usage: { inputTokens: number; outputTokens: number }
    response?: { id?: string; modelId?: string; headers?: Record<string,string> }
  }>

  doStream(options: LanguageModelV2CallOptions): Promise<{
    stream: ReadableStream<LanguageModelV2StreamPart>
    response?: Promise<{ id?: string; modelId?: string; headers?: Record<string,string> }>
  }>
}
```

**這就是分界線**。Layer A/B/C 只透過這個 interface 互動。我們實作這個 interface，就完全控制 HTTP 層。

---

## Target Architecture

```
┌─── ai core (保留) ──────────────────────────────┐
│  streamText({ model, messages, tools, ... })     │
│         │                                        │
│         ▼                                        │
│  wrapLanguageModel({ model, middleware })         │
│         │  transformParams (ProviderTransform)    │
│         ▼                                        │
│  model.doStream(options)                         │
│         │                                        │
└─────────┼────────────────────────────────────────┘
          │
          ▼
┌─── opencode-claude-provider (新建) ──────────────┐
│                                                   │
│  ClaudeCodeLanguageModel implements LMv2          │
│                                                   │
│  doStream(options):                               │
│    │                                              │
│    ├─ 1. convertMessages(options.prompt)           │
│    │     LMv2 message format → Anthropic format   │
│    │                                              │
│    ├─ 2. buildSystemPrompt(options)                │
│    │     identity + sections + boundary + cache    │
│    │                                              │
│    ├─ 3. convertTools(options.tools)               │
│    │     LMv2 tools → Anthropic tools + mcp__     │
│    │                                              │
│    ├─ 4. buildHeaders(auth, model)                 │
│    │     從零建構，無 SDK 殘留                      │
│    │     Authorization, anthropic-beta,            │
│    │     User-Agent, billing header, etc.          │
│    │                                              │
│    ├─ 5. fetch(url, { headers, body })             │
│    │     直接呼叫 globalThis.fetch                 │
│    │     URL: /v1/messages?beta=true               │
│    │                                              │
│    └─ 6. parseSSE(response.body)                   │
│          Anthropic SSE → LMv2 StreamPart           │
│          + mcp__ prefix stripping                  │
│          + usage extraction                        │
│                                                   │
│  auth.ts: OAuth PKCE + token refresh               │
│  protocol.ts: constants (VERSION, betas, salt)     │
│  models.ts: model catalog                          │
│  convert.ts: LMv2 ↔ Anthropic format converters   │
│  sse.ts: SSE parser                               │
│                                                   │
└───────────────────────────────────────────────────┘
```

---

## Module 拆分

### 可共用 (Keep)

| Module | Source | 用途 |
|---|---|---|
| `streamText` | `ai` | Orchestration, tool loop, retry |
| `wrapLanguageModel` | `ai` | Middleware (message transform) |
| `LanguageModelV2` | `@ai-sdk/provider` | Interface contract |
| `LanguageModelV2StreamPart` | `@ai-sdk/provider` | Stream event types |
| `ProviderTransform` | opencode `transform.ts` | Message/cache transform |

### Provider Exclusive (Replace)

| Module | 取代誰 | 職責 |
|---|---|---|
| `convert.ts` | `@ai-sdk/anthropic` getArgs() | LMv2 prompt → Anthropic messages/system/tools |
| `headers.ts` | `@ai-sdk/anthropic` getHeaders() | 從零建構全部 HTTP headers |
| `sse.ts` | `@ai-sdk/anthropic` response parser | SSE → LMv2 StreamPart |
| `auth.ts` | `anthropic.ts` auth.loader | OAuth PKCE + token refresh |
| `protocol.ts` | `anthropic.ts` constants | VERSION, CLIENT_ID, betas, salt |
| `models.ts` | `provider.ts` hardcoded catalog | Model IDs, context, pricing |
| `provider.ts` | `createAnthropic()` | LanguageModelV2 factory |

---

## Data Flow 對比

### Before (v2: SDK + scrub)

```
LMv2CallOptions
  → @ai-sdk/anthropic.getArgs()     組 body (SDK 格式)
  → @ai-sdk/anthropic.getHeaders()  加 anthropic-client, x-api-key (污染)
  → wrapped fetch (provider.ts)      合併 custom-loaders headers (再污染)
  → plugin fetch (anthropic.ts)      scrub headers, parse+modify body (擦屁股)
  → globalThis.fetch                 HTTP wire
```

### After (v3: native LMv2)

```
LMv2CallOptions
  → ClaudeCodeLanguageModel.doStream()
    → convertMessages()              自己組 body
    → buildHeaders()                 自己組 headers (從零開始)
    → globalThis.fetch               HTTP wire (零中間層)
```

**差異**：v2 有 4 層 header 合併/scrub，v3 只有 1 層。body 不需 parse→modify→re-serialize。

---

## Key Design Decisions

### D1: 完全取代 @ai-sdk/anthropic

不再 `createAnthropic()`，改為自製 `createClaudeCode()` 回傳 `LanguageModelV2`。

好處：
- 零 header 污染
- Body 結構完全控制
- System prompt cache_control 精確放置
- mcp__ prefix 在序列化前處理，不需 post-serialize regex

風險：
- 需自己實作 LMv2 message → Anthropic message 轉換
- 需自己實作 SSE parser

Mitigation：
- `@ai-sdk/anthropic` 的 converter 可作為參考（不是 copy）
- SSE parser 很簡單（event: / data: / blank line），~100 行

### D2: auth 與 transport 分離

```
auth.ts:    OAuth PKCE + token refresh → returns { accessToken, orgID }
provider.ts: 用 accessToken 組 Authorization header → 發 fetch
```

auth 不再包在 fetch 裡。Provider factory 初始化時取得 auth，每次 request 前檢查 token，過期就 refresh。

### D3: System Prompt 結構對齊官方

```typescript
function buildSystemBlocks(sections, enableCaching) {
  const blocks = []

  // Block 0: billing header (no cache)
  blocks.push({ type: "text", text: billingHeader, cache_control: undefined })

  // Block 1: identity (org-level cache)
  blocks.push({ type: "text", text: IDENTITY, cache_control: cQ("org") })

  // Block 2: static sections (global cache) — before boundary
  blocks.push({ type: "text", text: staticSections, cache_control: cQ("global") })

  // Block 3+: dynamic sections (no cache) — after boundary
  for (const section of dynamicSections) {
    blocks.push({ type: "text", text: section })
  }

  return blocks
}
```

完全控制 `cache_control` 的 scope 和 TTL。

### D4: Host 端解耦

Provider 透過 `LanguageModelV2` interface 註冊，host 不需知道是 Anthropic：

```typescript
// provider.ts 中
const language = createClaudeCode({ auth, model: modelId })

// 傳給 streamText
streamText({ model: wrapLanguageModel({ model: language, middleware }) })
```

Host 端的 `isClaudeCode` 分支、`custom-loaders-def.ts` 的 anthropic headers — 全部刪除。Provider 自己處理一切。

### D5: 參考 @ai-sdk/anthropic 但不依賴

需要自己寫的 converter：

| Converter | 輸入 | 輸出 | 複雜度 |
|---|---|---|---|
| `convertMessages` | `LanguageModelV2Prompt` | Anthropic `messages[]` | Medium — 處理 text/image/tool_use/tool_result |
| `convertTools` | `LanguageModelV2FunctionTool[]` | Anthropic `tools[]` + mcp__ prefix | Low |
| `convertSystemPrompt` | `string[]` sections | Anthropic `system[]` blocks + cache_control | Medium |
| `parseSSEStream` | `ReadableStream<Uint8Array>` | `ReadableStream<LanguageModelV2StreamPart>` | Medium — map Anthropic events to LMv2 types |

總量預估：~800 行 TypeScript（converter + SSE parser + provider factory）。

---

## Module Dependency Graph

```
opencode-claude-provider/
  │
  ├── provider.ts        ← LanguageModelV2 factory (entry point)
  │     uses: auth, protocol, models, convert, headers, sse
  │
  ├── auth.ts            ← OAuth PKCE + token refresh
  │     uses: protocol (CLIENT_ID, SCOPES, ENDPOINTS)
  │
  ├── protocol.ts        ← All constants from official 2.1.92
  │     VERSION, CLIENT_ID, ATTRIBUTION_SALT, BETAS, SCOPES
  │     IDENTITY_STRINGS, ENDPOINTS
  │     (single file to update when official CLI upgrades)
  │
  ├── models.ts          ← Static model catalog
  │     model IDs, context windows, max output, pricing
  │
  ├── convert.ts         ← LMv2 ↔ Anthropic format converters
  │     convertPrompt(), convertTools(), convertSystemBlocks()
  │
  ├── headers.ts         ← HTTP header builder (from scratch)
  │     buildHeaders(auth, model, betas, content)
  │     buildBillingHeader(content, version)
  │     assembleBetas(auth, model, features)
  │
  └── sse.ts             ← SSE stream parser
        parseAnthropicSSE() → ReadableStream<LMv2StreamPart>
        handles: message_start, content_block_*, message_delta, message_stop
        strips mcp__ prefix from tool names
```

---

## Risk Register

| Risk | L | I | Mitigation |
|---|---|---|---|
| LMv2 message converter 有 edge case（image、多輪 tool） | M | H | 參考 @ai-sdk/anthropic converter，寫 test vectors |
| SSE parser 漏處理某個 event type | M | M | 用 protocol-datasheet.md 的 event schema 逐一驗證 |
| streamText() 升級改了 LMv2 interface | L | H | Pin ai 版本，升級時 review interface changes |
| Host 端殘留 @ai-sdk/anthropic 依賴 | M | M | 其他 provider 仍用 SDK，只 claude-cli 不用 |
| doGenerate (非 streaming) 也需要實作 | M | L | 先 stub throw，opencode 主流程都用 streamText |
| Prompt caching 的 cache_control 格式微調 | L | H | 用 system-prompt-datasheet.md 逐 block 對齊 |

---

## v2 → v3 Migration Path

| v2 Step | v3 替代 |
|---|---|
| Phase 0: Protocol sync | 保留 — 常數搬到 `protocol.ts` |
| Phase 1: Hook 拆解 | 取消 — 不需要 hooks，provider 自己處理 |
| Phase 2: Host 硬編碼清除 | 保留 — 仍需清除 `isClaudeCode` 等 |
| Phase 3: Plugin pack | 變成 LMv2 provider package |
