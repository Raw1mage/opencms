# Implementation Spec

## Goal

- 為 codex provider 啟用 OpenAI Responses API 的 5 項 server-side 效能優化（prewarm 除外），將長對話 token 消耗降低 50-90%

## Scope

### IN

- Phase 1: prompt_cache_key + sticky routing（✅ 已完成）
- Phase 2: encrypted reasoning reuse + zstd compression + providerOptions 注入
- Phase 3: WebSocket transport + incremental delta（fetch interceptor transport adapter 架構）
- Phase 4: server-side compaction + context_management

### OUT

- 其他 provider 的效能優化
- C library WebSocket（用 Bun 原生 WebSocket）
- CUSTOM_LOADER path（已廢棄）
- Prewarm（generate: false）— 擱置
- client-side compaction 改進

## Assumptions

- OpenAI Responses API 接受 `prompt_cache_key` 欄位（codex-rs 已使用）✅ 已驗證
- `x-codex-turn-state` header 會由 server 回傳且接受 replay ✅ 已驗證
- AI SDK `@ai-sdk/openai` adapter 支援 `previousResponseId`、`store`、`serviceTier` 等 providerOptions ✅ 已驗證（見 aisdk-refactor design.md）
- WebSocket endpoint 支援 `previous_response_id` 做 incremental delta（codex-rs 已使用）
- Bun 原生 WebSocket client 能連接 OpenAI WebSocket endpoint
- AI SDK SSE parser 能消費 synthetic Response（WS events → SSE format 轉換）

## Stop Gates

- **SG-1**: 如果 `prompt_cache_key` 被 server 忽略（quota 沒有下降），暫停並分析 packet
- **SG-2**: 如果 WebSocket handshake 被 server 拒絕，停留在 HTTP SSE 路徑
- **SG-3**: 如果 encrypted reasoning 造成 request body 過大（超過 context window），需要 truncation 策略
- **SG-4**: 如果 AI SDK SSE parser 無法消費 synthetic Response（WS→SSE 格式不相容），需深入分析 parser 預期格式

## Critical Files

- `packages/opencode/src/session/llm.ts` — LLM call orchestration, providerOptions injection, response_id tracking
- `packages/opencode/src/plugin/codex.ts` — custom fetch, header injection, **WebSocket transport adapter**
- `packages/opencode/src/session/compaction.ts` — compaction integration point
- `packages/opencode/src/provider/codex-websocket.ts` — 舊 WebSocket（參考用）
- `node_modules/@ai-sdk/openai/dist/index.js` — 參考：SSE parser 預期格式

## Structured Execution Phases

### Phase 1: Prompt Cache + Sticky Routing ✅ DONE

HTTP-only，只加 request field 和 header。

### Phase 2: Reasoning Reuse + Compression + providerOptions

1. 在 llm.ts 注入 `providerOptions.openai.store = false` 給 codex provider
2. 在 llm.ts 注入 `providerOptions.openai.serviceTier = "priority"` 給 codex provider
3. 驗證 encrypted_content 在 session history replay 中完整保留
4. 清理 fetch interceptor 重複邏輯（prompt_cache_key 已可透過 providerOptions 處理）
5. 驗證：比較 reasoning token 消耗 + 壓縮率

### Phase 3: WebSocket Transport + Incremental Delta

> 新架構：fetch interceptor transport adapter，不離開 AI SDK pipeline。

1. 建立 WebSocket connection manager（per-session persistent connection）
2. 實作 WS ↔ SSE transport adapter（WS events → SSE format → synthetic Response）
3. 在 llm.ts 追蹤 response_id，注入 `providerOptions.openai.previousResponseId`
4. 實作 incremental delta detection（只有 input append 才走 delta）
5. 實作 transport fallback（WS 失敗 → HTTP SSE）
6. 驗證：WS 連線、delta token 節省、fallback

### Phase 4: Server-side Compaction + context_management

1. 實作 `/responses/compact` API call
2. 整合到 compaction trigger（codex 優先 server compact）
3. 在 fetch interceptor 加入 `context_management` body field
4. 驗證：compact 後 context 縮減 > 50%

## Validation

### Phase 1 ✅
- [x] Request 帶 `prompt_cache_key` 欄位
- [ ] `cached_input_tokens` > 0 在第二次 turn
- [ ] `x-codex-turn-state` 被 capture 並 replay
- [x] 無 regression：codex provider 正常對話

### Phase 2
- [ ] `providerOptions.openai.store = false` 生效 → `include` 自動含 `reasoning.encrypted_content`
- [ ] `providerOptions.openai.serviceTier = "priority"` 生效
- [ ] Reasoning encrypted_content 在 session history replay 中完整保留
- [ ] 壓縮率 > 2x

### Phase 3
- [ ] WebSocket connection 建立成功
- [ ] AI SDK SSE parser 正確消費 synthetic Response（格式驗證）
- [ ] Incremental delta 的 `input_tokens` < 全量的 50%
- [ ] WebSocket 失敗時自動 fallback 到 HTTP SSE
- [ ] Mid-request WS 斷線時自動 HTTP retry

### Phase 4
- [ ] `/responses/compact` 呼叫成功
- [ ] Compaction 後 conversation history token count 降低 > 50%
- [ ] `context_management` 欄位出現在 request body

## Handoff

- Build agent must read this spec first.
- Build agent must read companion artifacts (design.md, tasks.md) before coding.
- **重要**: Phase 3 的舊 code（codex-websocket.ts、codex-language-model.ts）僅供參考，不可直接使用。新 WebSocket 必須在 fetch interceptor 架構內實作。
- Wire protocol reference: `specs/codex-protocol/whitepaper.md`
- AI SDK 架構分析: `plans/aisdk-refactor/design.md`
