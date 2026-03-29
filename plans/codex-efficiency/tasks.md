# Tasks

## 1. Prompt Cache + Sticky Routing ✅ DONE

- [x] 1.1 在 codex custom fetch 中注入 `prompt_cache_key: session_id` 到 request body
- [x] 1.2 在 codex custom fetch 中 capture response header `x-codex-turn-state`
- [x] 1.3 建立 per-turn state storage — codexTurnState module-level object
- [x] 1.4 在 codex custom fetch 中 replay `x-codex-turn-state` header
- [x] 1.5 Turn state lifecycle：新 user message 時清除 turnState（chat.message hook）
- [ ] 1.6 驗證：送 2 個 turn，確認第二個 turn 的 `cached_input_tokens > 0`（log 比較）
- [ ] 1.7 驗證：tool-call loop 中確認 `x-codex-turn-state` header 被 replay（log）

## 2. Encrypted Reasoning + Compression + providerOptions

- [x] 2.1 確認 AI SDK adapter 在 store=false 時自動加 `include: ["reasoning.encrypted_content"]`
- [x] 2.2 確認 AI SDK SSE parser 保留 encrypted_content 到 providerMetadata
- [x] 2.3 ~~x-reasoning-included header~~ → 由 AI SDK adapter 自動處理
- [x] 2.4 實作 zstd request body compression
- [x] 2.5 Compression fallback（zstd → gzip → no compression）
- [ ] 2.6 在 llm.ts 注入 `providerOptions.openai.store = false` 給 codex provider
- [ ] 2.7 在 llm.ts 注入 `providerOptions.openai.serviceTier = "priority"` 給 codex provider
- [ ] 2.8 驗證 session history replay 完整保留 reasoning encrypted_content
- [ ] 2.9 驗證：比較連續 turn 的 reasoning token 消耗
- [ ] 2.10 驗證：壓縮率 > 2x（log body size before/after）

## 3. WebSocket Transport + Incremental Delta ← 重新規劃

> ⚠️ 舊任務 3.1-3.9（CUSTOM_LOADER 架構）已失效，不適用。
> 新架構：WebSocket 透過 fetch interceptor transport adapter，不離開 AI SDK pipeline。
> Prewarm 擱置。

### 3A. WebSocket Connection Manager

- [ ] 3A.1 在 codex.ts 建立 WebSocket connection manager — per-session persistent connection
  - endpoint: `wss://chatgpt.com/backend-api/codex/ws`（需確認實際 endpoint）
  - handshake headers: Authorization, ChatGPT-Account-Id, OpenAI-Beta, originator, User-Agent
  - connection state: `idle | connecting | open | failed`
- [ ] 3A.2 Connection lifecycle — open on first codex request, reuse across tool-call loop, close on session end / error
- [ ] 3A.3 Connection health — heartbeat/ping detection, auto-reconnect on unexpected close
- [ ] 3A.4 Failure isolation — wsFailed flag per session, WS 失敗後整個 session fallback to HTTP

### 3B. WebSocket ↔ SSE Transport Adapter

- [ ] 3B.1 在 fetch interceptor 中偵測 WebSocket 可用 → 走 WS path 而非 HTTP
- [ ] 3B.2 發送邏輯 — parse request body JSON → 包裝成 `{ type: "response.create", ...body }` → send as WS text frame
- [ ] 3B.3 接收邏輯 — WS text frames (JSONL events) → transform to SSE format (`data: {event}\n\n`)
- [ ] 3B.4 建構 synthetic Response — `new Response(readableStream, { headers: { "content-type": "text/event-stream" } })`
- [ ] 3B.5 Stream lifecycle — `response.completed` / `response.failed` / WS error → close ReadableStream
- [ ] 3B.6 驗證 AI SDK SSE parser 能正確消費 synthetic Response（格式比對測試）

### 3C. Incremental Delta

- [ ] 3C.1 在 llm.ts 追蹤上一次 response_id — capture from AI SDK providerMetadata (responseId)
- [ ] 3C.2 在 llm.ts 注入 `providerOptions.openai.previousResponseId` 給 codex provider
- [ ] 3C.3 Delta detection — 比較 instructions + tools 是否變更，只有 input append 才走 delta
- [ ] 3C.4 delta 可用時：AI SDK adapter 自動帶 `previous_response_id` → WS path 只送 delta input
- [ ] 3C.5 delta 不可用時（instructions/tools 變了）：送全量，不帶 previous_response_id

### 3D. Fallback + Validation

- [ ] 3D.1 Transport fallback — WS 連線失敗 / handshake 拒絕 → 自動走 HTTP path
- [ ] 3D.2 Mid-request fallback — WS 在 streaming 中斷 → 以 HTTP 重送同一 request
- [ ] 3D.3 驗證：WS 連線成功（log connection established + handshake details）
- [ ] 3D.4 驗證：incremental delta 的 input_tokens < 全量的 50%（log 比較）
- [ ] 3D.5 驗證：WS 失敗時自動 fallback 到 HTTP SSE

## 4. Server-side Compaction

- [ ] 4.1 實作 `/responses/compact` API call
- [ ] 4.2 整合到 compaction trigger — codex provider 優先嘗試 server compact
- [ ] 4.3 Compact result 處理 — 用 compacted history 替換 session history
- [ ] 4.4 Fallback — server compact 失敗時 fallback 到 client-side compaction
- [ ] 4.5 驗證：compact 後 context token count 降低 > 50%

## 5. context_management (Inline Compaction)

- [ ] 5.1 在 fetch interceptor body transform 加入 `context_management: [{type: "compaction", compact_threshold: N}]`
- [ ] 5.2 threshold 值從 config 讀取（或 model context window 80% 作為預設）
- [ ] 5.3 驗證：request body 包含 context_management 欄位
