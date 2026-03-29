# Design

## Context

- codex provider 已上線，走 AI SDK Responses API + custom fetch interceptor
- CUSTOM_LOADER（CodexLanguageModel + WebSocket + C binary）已廢棄（見 aisdk-refactor plan）
- Phase 1-2（prompt_cache_key、turn_state、zstd）已在 fetch interceptor 中生效
- Phase 3（WebSocket）的舊 code 存在但未使用——需以新架構重新實作
- Prewarm 擱置（非瓶頸）

## Goals / Non-Goals

**Goals:**

- 啟用全部 5 項 Responses API server-side 優化（prewarm 除外）
- 每個 Phase 獨立交付、獨立驗證
- graceful degradation — server 不支援時不影響功能
- WebSocket 必須做，作為 incremental delta 的基礎

**Non-Goals:**

- 不改其他 provider
- 不做 client-side 演算法優化（context truncation 等）
- 不做 UI 層的 cache 狀態顯示
- 不做 prewarm（generate: false）

## Decisions

### DD-1: Phase 1 走 AI SDK custom fetch path（不動 C transport）

**Decision**: prompt_cache_key 和 sticky routing 透過 custom fetch interceptor 注入。

**Rationale**: 只是 request field 和 header，fetch interceptor 幾行搞定。

**Status**: ✅ 已實作並上線。

### DD-2: Turn state 管理放在 plugin 層的 module-level state

**Decision**: `x-codex-turn-state` 的 capture/replay lifecycle 放在 `codex.ts` 的 `codexTurnState` 物件。新 turn 時由 `chat.message` hook 清除。

**Status**: ✅ 已實作並上線。

### DD-3: Reasoning encrypted_content 存在 conversation history 裡

**Decision**: response 的 reasoning item with encrypted_content 原封不動存入 conversation history。下次構建 input 時自然包含。

**Rationale**: conversation history 已經是 SSOT。AI SDK `@ai-sdk/openai` adapter 在 `store=false` 時自動加 `include: ["reasoning.encrypted_content"]`，SSE parser 已保留 encrypted_content 到 providerMetadata。

**Status**: ⚠️ 待驗證 session history replay 是否完整保留 encrypted_content。

### DD-4: WebSocket 作為 fetch interceptor 的 transport adapter（取代 DD-4 原案）

**Decision**: WebSocket transport 在 fetch interceptor 內實作，不透過 CUSTOM_LOADER。

**Architecture**:
```
AI SDK @ai-sdk/openai adapter
  → 構建完整 request body (input, tools, instructions, ...)
  → fetch(url, { body, headers })
      ↓
codex.ts fetch interceptor
  ├─ [HTTP mode] → 直接 fetch(codex_url, ...) → SSE Response
  └─ [WebSocket mode] → 開 WebSocket → 送 body 為 WS message
                       → 收 WS events → 包裝成 synthetic SSE Response
                       → 回傳給 AI SDK（AI SDK 不知道底層是 WS）
```

**Rationale**:
- 保留 AI SDK 完整 pipeline（tool loop、validation、lifecycle）
- AI SDK adapter 照常構建 request body — 所有 providerOptions 正常生效
- Fetch interceptor 只是換了 wire transport（HTTP → WS），不影響上層
- Fallback 天然：WS 失敗 → 走原本的 HTTP fetch path

**Key implementation detail**: fetch interceptor 回傳的 Response 物件需要一個 ReadableStream body，裡面是 SSE-formatted text。WebSocket 收到的 JSONL events 需要轉成 `data: {...}\n\n` 格式，讓 AI SDK 的 SSE parser 正常消費。

### DD-5: Compression 用 Bun 內建

**Decision**: 用 Bun 內建壓縮。zstd 優先，不支援則 gzip，都不行則不壓縮。

**Status**: ✅ 已實作。

### DD-6: Server compaction 作為 client compaction 的替代路徑

**Decision**: codex + context 超限時，優先嘗試 `/responses/compact`。失敗時 fallback 到 client-side compaction。

### DD-7: Prewarm 擱置

**Decision**: generate: false 預熱功能暫不實作。

**Rationale**: prewarm 依賴 previous_response_id + typing event detection，目前非瓶頸。WebSocket + incremental delta 的 token 節省遠大於 prewarm 的延遲節省。

### DD-8: Incremental delta 透過 providerOptions 注入

**Decision**: `previous_response_id` 透過 `providerOptions.openai.previousResponseId` 傳入，AI SDK adapter 已原生支援此欄位。Delta 計算邏輯在 session/llm.ts 層。

**Rationale**: AI SDK `@ai-sdk/openai` adapter 已將 `previous_response_id` 放入 request body（見 aisdk-refactor design.md 分析）。不需要 fetch interceptor 額外處理。

## Data / State / Control Flow

### Turn State Lifecycle

```
Turn Start (new user message)
  │ turn_state = null  (chat.message hook)
  │ response_id = null
  │
  ▼ First LLM request
  │ headers: no x-codex-turn-state
  │ body: prompt_cache_key = session_id
  │
  ▼ First response
  │ capture: x-codex-turn-state from header
  │ capture: response_id from completed event
  │ capture: reasoning encrypted_content from items
  │
  ▼ Tool call → follow-up request (same turn)
  │ headers: x-codex-turn-state = captured value
  │ body: includes previous reasoning encrypted_content
  │
  ▼ Turn End
  │ response_id saved for next turn (incremental delta)
  │ turn_state cleared (new turn = fresh routing)
```

### WebSocket Transport Adapter Flow（新架構）

```
AI SDK calls fetch(url, { body, headers })
  │
  ▼ codex.ts fetch interceptor
  │
  ├─ wsEnabled && !wsFailed?
  │   │
  │   ▼ YES: WebSocket path
  │   │ 1. Get/create WS connection (persistent per session)
  │   │ 2. Parse request body JSON
  │   │ 3. If previous_response_id available:
  │   │    → compute delta input (new items only)
  │   │    → send { type: "response.create", previous_response_id, input: delta }
  │   │ 4. Else:
  │   │    → send { type: "response.create", ...fullBody }
  │   │ 5. Create ReadableStream that:
  │   │    → receives WS text frames (JSONL events)
  │   │    → transforms to SSE format: "data: {event}\n\n"
  │   │    → on "response.completed" / error → close stream
  │   │ 6. Return synthetic Response(stream, { headers: sse-headers })
  │   │
  │   ▼ WS error during request?
  │     → set wsFailed = true
  │     → fall through to HTTP path (retry same request)
  │
  └─ NO: HTTP path (current behavior)
      → fetch(codex_url, { body, headers })
      → return SSE Response
```

### WebSocket Connection Lifecycle

```
Session Start
  │ ws = null, wsEnabled = true, wsFailed = false
  │
  ▼ First codex fetch intercepted
  │ ws = new WebSocket(wsEndpoint, { headers })
  │ await ws.open
  │
  ▼ Subsequent requests (same session)
  │ reuse ws connection
  │ if ws.readyState !== OPEN → reconnect or fallback
  │
  ▼ Session End / WS Error
  │ ws.close()
  │ wsFailed = true → all subsequent requests use HTTP
```

## Risks / Trade-offs

- **R1: prompt_cache_key 被 server 忽略** → 功能正常但沒有 cache 效益。Mitigation: 檢查 cached_input_tokens 確認 cache hit
- **R2: ~~WebSocket endpoint 變更~~** → 改為：Bun WebSocket client 與 codex endpoint 的 protocol 不相容。Mitigation: 詳細 handshake logging + HTTP fallback
- **R3: encrypted reasoning 造成 body 膨脹** → 長 reasoning chain 的 encrypted content 可能很大。Mitigation: 設定 max reasoning items 保留數量
- **R4: ~~zstd 壓縮在 Bun 中不支援~~** → 已驗證 Bun 支援
- **R5: server compaction endpoint 不存在** → 404 或 unsupported。Mitigation: fallback 到 client compaction
- **R6: WebSocket → SSE 格式轉換** → AI SDK 的 SSE parser 期望特定格式（`data: ...\n\n`）。如果格式不對，整個 stream 壞掉。Mitigation: 參考 `@ai-sdk/openai` 的 SSE parse source 確認預期格式
- **R7: WebSocket 併發隔離** → 多個 request 共用一個 WS connection 時需要 multiplexing 或 serialization。Mitigation: 一個 WS connection 同時只處理一個 request（codex API 特性：一個 connection 一個 turn）

## Critical Files

- `packages/opencode/src/session/llm.ts` — turn state management, request construction, providerOptions injection
- `packages/opencode/src/plugin/codex.ts` — custom fetch interceptor, header injection, **WebSocket transport adapter**
- `packages/opencode/src/session/compaction.ts` — compaction trigger integration
- `packages/opencode/src/provider/codex-websocket.ts` — 舊 WebSocket code（參考用，不直接使用）
- `packages/opencode/src/provider/codex-language-model.ts` — 舊 CUSTOM_LOADER（參考用，不直接使用）
