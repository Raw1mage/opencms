# Proposal

## Why

- opencode 目前對 codex provider 的 Responses API 使用方式是「最基本模式」——每次全量送 conversation history，不帶 cache hint，不做 sticky routing
- 使用者回報「一小時燒掉一週用量」，根因是每個 turn 重送完整 context（含歷史 reasoning tokens），沒有利用 server-side cache
- OpenAI Responses API 提供 6 項 server-side 效能機制，codex-rs 全部有使用，但 opencode 目前一項都沒啟用
- 長對話場景下，token 浪費可達 10x+（重複送的 input tokens = 已 cached 但沒告知 server）

## Original Requirement Wording (Baseline)

- "請擬定一個plan，把上述server side api支援、高價值效能優化功能都加入實作計畫中。原則上先實作在codex provider上。"
- "我在opencode上調用LLM一小時可燒掉一週用量，禍首就是因為沒優化。"

## Requirement Revision History

- 2026-03-29: Initial requirement — implement all 6 Responses API efficiency features for codex provider
- 2026-03-29: Prewarm 擱置；WebSocket transport 確認為必做項（不隨 CUSTOM_LOADER 廢棄）
- 2026-03-29: AI SDK 架構分析完成 → WebSocket 改為 fetch interceptor transport adapter 架構

## Effective Requirement Description

1. 為 codex provider 啟用 OpenAI Responses API 的全部 server-side 效能優化
2. 降低長對話的 token 消耗至少 50%（目標 90%）
3. 降低首 token 延遲（cache hit）
4. 先在 codex provider 實作，驗證後可推廣到 openai provider

## Scope

### IN

- prompt_cache_key 注入（每個 session 固定 key，server 做 prefix cache）
- sticky routing（capture/replay x-codex-turn-state header）
- encrypted reasoning content 回傳重用（上一次的 reasoning 下次原封送回）
- zstd request body compression
- WebSocket transport + incremental delta（persistent connection，只送新增 input）
- server-side compaction（/responses/compact endpoint）

### OUT

- 非 codex provider 的 provider 優化（後續推廣）
- client-side compaction 改進（已有，不在此 scope）
- UI/admin panel 的 cache 狀態顯示（可後續加）
- C library 的 WebSocket 實作（用 TS/Bun 原生 WebSocket）
- Prewarm（generate: false 預熱）— 擱置，非瓶頸

## Non-Goals

- 不改變 conversation history 的語意結構
- 不改變 tool calling 的行為
- 不修改其他 provider 的 data path

## Constraints

- 所有機制必須 graceful degrade：server 不支援時不影響功能
- prompt_cache_key 和 sticky routing 必須 per-session 隔離
- WebSocket 必須有 HTTP SSE fallback（現有路徑）
- encrypted reasoning 的安全性由 server 保證，client 只做 pass-through

## What Changes

- `packages/opencode/src/provider/provider.ts` — codex loader 注入 cache/routing 參數
- `packages/opencode/src/session/llm.ts` — turn-level state 管理（turn_state, response_id）
- `packages/opencode/src/plugin/codex.ts` — custom fetch 注入 headers + compression
- `packages/opencode/src/provider/codex-language-model.ts` — C transport 支援新參數
- `packages/opencode-codex-provider/src/main.c` — C binary 支援 turn_state header
- `packages/opencode-codex-provider/src/transport.c` — WebSocket transport (新增)
- 新增 WebSocket client module（TS 或 C）

## Capabilities

### New Capabilities

- **Prompt Cache**: server-side prompt prefix cache，同 session 內重複 prompt 不重新計算
- **Sticky Routing**: 同一 turn 的 requests 固定到同一台 server，KV cache 命中
- **Reasoning Reuse**: reasoning tokens 加密回傳，下次 request 免重算
- **Request Compression**: zstd 壓縮長 request body
- **Incremental Delta**: WebSocket 只送新增 input，不重送整個 history
- **Server Compaction**: server 端做 history 摘要

### Modified Capabilities

- **codex provider LLM call**: 從全量 HTTP SSE 升級為 WebSocket + delta + cache

## Impact

- Token 消耗：長對話預期降低 50-90%
- 首 token 延遲：cache hit 時降低 30-60%
- Bandwidth：delta + compression 降低 70%+
- 檔案變更：~8 個 TS 檔 + 2 個 C 檔
