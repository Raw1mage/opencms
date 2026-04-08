# Tasks

## 1. Upstream 分析

- [ ] 1.1 `cd refs/codex && git fetch origin` — 拉最新
- [ ] 1.2 分析 codex-rs Responses API client 的 protocol 結構
- [ ] 1.3 記錄 native protocol spec（request/response format、WS handshake、delta 語義）
- [ ] 1.4 產出 opencode 現有實作 vs upstream 的差異清單

## 2. AI SDK 子模塊拆分設計

- [ ] 2.1 盤點 AI SDK 在 codex 路徑的使用點
- [ ] 2.2 識別可重用部分（message format、tool schema、SSE parsing、token counting）
- [ ] 2.3 識別不可重用部分（`@ai-sdk/openai` adapter、provider headers、model mapping）
- [ ] 2.4 設計 shared utility module 結構
- [ ] 2.5 產出設計文件（更新 design.md）

## 3. Codex Plugin Package 設計

- [ ] 3.1 定義 plugin 目錄結構
- [ ] 3.2 設計 native Responses API client（不經 AI SDK）
- [ ] 3.3 設計 message conversion（用 shared utility）
- [ ] 3.4 設計 response parsing（SSE → structured events）
- [ ] 3.5 設計 HTTP delta transport（previous_response_id over HTTP）
- [ ] 3.6 設計 plugin ↔ rotation3d rate limit 整合介面

## 4. 實作 Codex Plugin

- [ ] 4.1 建立 `src/plugin/codex/` 目錄結構
- [ ] 4.2 實作 types.ts（對齊 codex-rs protocol）
- [ ] 4.3 實作 identity.ts（originator、User-Agent、OpenAI-Beta、x-codex-* headers 集中定義）
- [ ] 4.4 實作 auth.ts（OAuth + PKCE）
- [ ] 4.5 實作 models.ts（model 定義 + context limits + compact_threshold 計算）
- [ ] 4.6 實作 compaction.ts（context_management 組裝，threshold 動態計算）
- [ ] 4.7 實作 continuation.ts（persistence layer）
- [ ] 4.8 實作 transport-ws.ts（從 codex-websocket.ts 搬出）
- [ ] 4.9 實作 transport-http.ts（HTTP SSE + delta + response_id capture）
- [ ] 4.10 實作 client.ts（統一 transport 選擇 + request construction + identity headers）
- [ ] 4.11 實作 index.ts（plugin entry）

## 5. AI SDK Shared Utilities 抽取

- [ ] 5.1 抽出 message format conversion
- [ ] 5.2 抽出 tool schema mapping
- [ ] 5.3 抽出 SSE stream parsing
- [ ] 5.4 放置到 shared module 位置
- [ ] 5.5 確認 codex plugin 和其他 provider 都可用

## 6. 整合 + Migration

- [ ] 6.1 更新 plugin/index.ts codex 註冊
- [ ] 6.2 移除舊 codex.ts / codex-websocket.ts / codex-native.ts
- [ ] 6.3 移除 provider.ts 中 codex model 定義 + CUSTOM_LOADER
- [ ] 6.4 移除 compaction.ts 中 codex server compaction 特殊路徑
- [ ] 6.5 更新 session/llm.ts codex 路徑
- [ ] 6.6 確認 rotation3d rate limit 整合
- [ ] 6.7 `grep -r "codex" --include="*.ts" src/ | grep -v "plugin/codex/"` — 確認 core 零 codex 殘留

## 7. 驗證

- [ ] 7.1 `bun test` 全過
- [ ] 7.2 Codex session 功能（tool calls、compaction、WS delta、HTTP fallback）
- [ ] 7.3 HTTP delta 驗證
- [ ] 7.4 Rate limit / quota tracking
- [ ] 7.5 其他 provider 不受影響
