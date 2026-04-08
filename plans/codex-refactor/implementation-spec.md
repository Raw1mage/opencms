# Implementation Spec

## Goal

將 Codex provider 從 opencode core 中分離為獨立的 zero-config plugin 檔案包，直接對接 OpenAI Responses API，不經 AI SDK provider adapter。同時拆分 AI SDK 為可重用和不可重用子模塊。

## Scope

### IN

- refs/codex submodule 更新 + upstream 差異分析
- codex.ts / codex-websocket.ts / codex-native.ts → 合併為 codex plugin package
- provider.ts 中 codex model 定義 → 搬進 plugin
- AI SDK 子模塊拆分
- Codex native Responses API client
- HTTP delta（previous_response_id over HTTP）

### OUT

- claude-cli plugin、其他 provider、`@opencode-ai/plugin` 介面 — 不修改

## Assumptions

- `@opencode-ai/plugin` 介面足以容納 codex 的所有需求（auth、fetch intercept、model registration）
- OpenAI Responses API 在 HTTP POST 接受 `previous_response_id`（需在 Phase 2 驗證）
- AI SDK 的 message format conversion 和 tool schema mapping 可抽為 standalone utility

## Stop Gates

- 如果 `@opencode-ai/plugin` 介面不足以支撐 codex 需求 → 需先擴展介面
- 如果 AI SDK 的 message format 不可分離（深度耦合 provider-specific 邏輯）→ 需要 fork 或 wrapper
- 如果 codex 的 rate limit tracking 無法在 plugin 層與 rotation3d 整合 → 需要定義 plugin ↔ core 的 rate limit 協議

## Critical Files

- `packages/opencode/src/plugin/codex.ts` (960 行) — 主要 auth + fetch interceptor
- `packages/opencode/src/plugin/codex-websocket.ts` (653 行) — WS transport + continuation
- `packages/opencode/src/plugin/codex-native.ts` (318 行) — native binary FFI
- `packages/opencode/src/plugin/claude-native.ts` (205 行) — 參考模板（zero-config plugin 範例）
- `packages/opencode/src/plugin/index.ts` — plugin 註冊
- `packages/opencode/src/provider/provider.ts:1260-1300` — codex model 定義
- `packages/opencode/src/session/llm.ts` — AI SDK streamText 呼叫點
- `refs/codex/codex-rs/codex-api/src/common.rs` — upstream protocol 定義

## Structured Execution Phases

### Phase 1: Upstream 分析

1. `cd refs/codex && git fetch origin && git log --oneline HEAD..origin/main` — 取得最新差異
2. 分析 codex-rs 的 Responses API client 實作（common.rs、client.rs、endpoint/responses.rs）
3. 記錄 codex native protocol：request format、response format、WS handshake、`previous_response_id` 行為、`context_management` 語義
4. 比對目前 opencode 的 codex plugin（AI SDK adapter）與 upstream 的差異清單

### Phase 2: AI SDK 子模塊拆分設計

1. 盤點 AI SDK 在 codex 路徑中的使用點（streamText → provider adapter → fetch）
2. 識別可重用部分：
   - Message format conversion（user/assistant/tool messages → Responses API input items）
   - Tool schema mapping（opencode tool definitions → OpenAI function tool JSON）
   - SSE stream parsing（event-source → structured events）
   - Token counting / usage extraction
3. 識別不可重用（codex-specific）部分：
   - `@ai-sdk/openai` provider adapter（會改寫 request body format）
   - Provider-specific header injection
   - Model ID mapping
4. 設計 shared utility module 結構

### Phase 3: Codex Plugin Package 設計

1. 定義 plugin 目錄結構：
   ```
   packages/opencode/src/plugin/codex/
   ├── index.ts          — plugin entry, implements @opencode-ai/plugin
   ├── auth.ts           — OAuth + PKCE + token refresh
   ├── client.ts         — native Responses API client (HTTP + WS)
   ├── transport-ws.ts   — WebSocket transport (from codex-websocket.ts)
   ├── transport-http.ts — HTTP SSE transport + delta support
   ├── continuation.ts   — previous_response_id persistence
   ├── models.ts         — model definitions + context limits
   └── types.ts          — Responses API types (aligned with codex-rs)
   ```
2. 設計 client.ts：直接 fetch `chatgpt.com/backend-api/codex`，不經 AI SDK
3. 設計 message conversion：用 shared utility 把 opencode messages → Responses API input items
4. 設計 response parsing：SSE stream → structured events → opencode assistant message

### Phase 4: 實作 Codex Plugin

1. 建立 `packages/opencode/src/plugin/codex/` 目錄
2. 實作 auth.ts（從 codex.ts 搬出 OAuth 邏輯）
3. 實作 types.ts（對齊 codex-rs 的 `ResponsesApiRequest` + `ResponseCreateWsRequest`）
4. 實作 identity.ts — protocol fingerprint 自描述：
   - `originator: "codex_cli_rs"`
   - `User-Agent: codex_cli_rs/{version} ({platform})`
   - `OpenAI-Beta: responses_websockets=2026-02-06`
   - `x-codex-turn-state`、`x-codex-turn-metadata`、`x-codex-beta-features`
   - 所有 codex-specific headers 集中定義，不散布 opencode core
5. 實作 client.ts（native HTTP fetch + request construction + identity headers）
6. 實作 transport-ws.ts（從 codex-websocket.ts 搬出，保留 delta + continuation）
7. 實作 transport-http.ts（新增 HTTP delta + SSE response_id capture）
8. 實作 continuation.ts（共用 ws-continuation.json persistence）
9. 實作 models.ts（從 provider.ts:1260-1300 搬出，包含 context limits、compact_threshold 計算）
10. 實作 compaction.ts — codex-specific compaction 參數（`context_management` 組裝，threshold 根據 model limit 動態計算）
11. 實作 index.ts（plugin entry，註冊到 @opencode-ai/plugin）

### Phase 5: AI SDK Shared Utilities 抽取

1. 從 `@ai-sdk/openai` 和 `session/llm.ts` 中抽出 message format conversion
2. 抽出 tool schema mapping
3. 抽出 SSE stream parsing utility
4. 放置到 `packages/opencode/src/provider/sdk/shared/` 或類似位置
5. 確認 codex plugin 和其他 provider 都能用

### Phase 6: 整合 + Migration

1. 更新 `plugin/index.ts` 的 codex 註冊為新 plugin
2. 移除舊的 codex.ts / codex-websocket.ts / codex-native.ts
3. 移除 provider.ts 中的 codex model 定義（搬進 plugin/codex/models.ts）
4. 移除 provider.ts 中的 codex CUSTOM_LOADER
5. 移除 codex.ts 中的 compact_threshold 硬編碼（搬進 plugin/codex/compaction.ts）
6. 移除 codex.ts 中的 prompt_cache_key 格式（搬進 plugin/codex/client.ts）
7. 移除 compaction.ts 中的 codex server compaction 特殊路徑（搬進 plugin）
8. 更新 session/llm.ts：codex 路徑不再走 AI SDK streamText
9. 確認 rotation3d 的 rate limit tracking 與新 plugin 整合
10. 確認 opencode core 中零 codex-specific 殘留（grep "codex" 排除 plugin/codex/ 目錄）

### Phase 7: 驗證

1. `bun test` 全過
2. Codex session 功能正常（tool calls、compaction、WS delta、HTTP fallback）
3. HTTP delta 驗證（`previous_response_id` over HTTP）
4. Rate limit / quota tracking 正常
5. 其他 provider 不受影響

## Validation

- Codex plugin 作為獨立檔案包，不 import opencode core 模組（除 `@opencode-ai/plugin` 介面）
- AI SDK 的 `@ai-sdk/openai` 不再出現在 codex 路徑中
- Request body 格式與 codex-rs upstream 一致（可用 DELTA-BREAKDOWN log 比對）
- WS delta 保持 84%+ hit rate
- HTTP delta 功能正常（如 API 支援）
- `bun test` 全過
- 其他 provider 行為不變

## Handoff

- Build agent must read this spec first.
- Build agent must read proposal.md before coding.
- Build agent must materialize runtime todo from tasks.md.
- **前置條件**: `plans/compaction-hotfix/` 必須先完成（compact_threshold 動態化 + SessionSnapshot 廢除）
