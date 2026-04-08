# Proposal

## Why

目前 Codex provider 的實作散布在 opencode core 內部，與 Bus、Session、Provider 等 core 模組深度耦合，無法獨立分離。這帶來三個問題：

1. **Server 把我們判定為第三方**：Codex server 靠 `originator` header 識別 client（first-party = `codex_cli_rs` / `codex_vscode` / `Codex *`）。我們沒送此 header，被判定為 third-party use，dashboard 顯示為第三方。這不是 header 的問題——根因是 codex-specific 的 protocol 行為（originator、User-Agent、`OpenAI-Beta`、`x-codex-turn-state` 等）散落在 opencode core 各處，由 fetch interceptor hack 注入，而非由 plugin 自描述。

2. **Codex protocol fingerprint 被 AI SDK 污染**：Codex 走的是 OpenAI Responses API（`chatgpt.com/backend-api/codex`），但經過 AI SDK 的 `streamText` → `@ai-sdk/openai` 轉換後，request/response 格式被改寫。Codex-rs 原生的 `previous_response_id`、`context_management`、WS `response.create`、`originator` header 等 protocol 特性，在 AI SDK 層都需要 hack（fetch interceptor body transform）才能注入。

3. **Codex-specific 硬編碼散布 opencode core 各處**：
   - `codex.ts:755` — `compact_threshold: 100000` 硬編碼
   - `provider.ts:1260-1300` — codex model 定義和 context limits
   - `codex.ts:750` — `prompt_cache_key` 格式
   - `codex.ts` fetch interceptor — body transform、auth、WS fallback 全部混在一起
   - `provider.ts:358` — codex CUSTOM_LOADER
   - `compaction.ts` — codex server compaction 特殊路徑

4. **無法像 claude-cli 一樣作為 zero-config plugin**：claude-cli（`claude-native.ts`）已經是獨立的 plugin 檔案，實作 `@opencode-ai/plugin` 介面。Codex 則是 3 個緊耦合檔案（codex.ts 960 行、codex-websocket.ts 653 行、codex-native.ts 318 行），加上 provider.ts 中的 model 定義、compaction.ts 中的 codex-specific 邏輯，合計 ~2000 行散布各處。opencode core 不應該知道任何 codex-specific 的東西。

5. **上游追蹤困難**：refs/codex submodule 的更新需要逐一分析再手動搬到 main，因為 codex 的 protocol 行為被 AI SDK adapter 層遮蔽，難以直接比對 upstream 變更的影響。

## Original Requirement Wording (Baseline)

- "在 codex_refactor plan 中，要重新 pull 最新 codex submodule，重新拆解程式"
- "把 codex 改寫成可從 opencode 分離的 zero config plugin 檔案包，跟我們對 claude-cli 所做的事一樣"
- "為了避免 AI-SDK 污染 codex 的 protocol fingerprint，要將 AI-SDK 拆成可重用和不可重用的子模塊，來為 codex plugin 製造適當的執行環境"

## Requirement Revision History

- 2026-04-08: 初始需求，從 quota 效率調查中衍生出的架構重構需求

## Effective Requirement Description

1. 重新 pull 最新 codex submodule（refs/codex），分析 upstream 變更
2. 將 codex provider 重構為獨立的 zero-config plugin 檔案包，實作 `@opencode-ai/plugin` 介面
3. 拆解 AI SDK 為可重用（transport、auth、message format）和不可重用（provider-specific adapter）子模塊
4. Codex plugin 直接對接 OpenAI Responses API，不經過 AI SDK 的 provider adapter
5. 保留 `previous_response_id`、`context_management`、WS transport 等 Codex 原生 protocol 特性，不被 AI SDK 抽象層改寫
6. HTTP delta（`previous_response_id` over HTTP）作為此重構的一部分實作

## Scope

### IN

- `refs/codex` submodule 更新與差異分析
- `packages/opencode/src/plugin/codex.ts` — 重構為獨立 plugin
- `packages/opencode/src/plugin/codex-websocket.ts` — 合併進 codex plugin
- `packages/opencode/src/plugin/codex-native.ts` — 合併進 codex plugin
- `packages/opencode/src/provider/provider.ts` 中的 codex model 定義 — 搬進 plugin
- AI SDK 子模塊拆分（識別可重用 vs 不可重用）
- Codex plugin 直接實作 Responses API client（不經 `@ai-sdk/openai`）
- HTTP delta（`previous_response_id` over HTTP）

### OUT

- claude-cli plugin — 不修改（作為參考模板）
- AI SDK core（`@ai-sdk/openai` npm package）— 不修改（只是不再用於 codex）
- 其他 provider（copilot、gemini-cli、anthropic）— 不修改

## Non-Goals

- 不修改 `@opencode-ai/plugin` 介面定義
- 不修改其他 provider 的 AI SDK 使用方式
- 不重寫 AI SDK（只拆分可重用部分）

## Constraints

- 必須保持 plugin 介面相容（`Hooks` + `PluginInput`）
- 必須保持 codex auth flow（OAuth + PKCE）不變
- WS transport 和 HTTP transport 都必須在 plugin 內部完成
- Codex Plus 的 rate limit / quota tracking 必須與 rotation3d 系統整合

## What Changes

- Codex 從 core-embedded 3 檔案 → 獨立 plugin 檔案包
- AI SDK 使用方式：codex 不再經過 `@ai-sdk/openai`，直接 fetch Responses API
- AI SDK 可重用部分（message format conversion、tool schema mapping）被抽為 shared utility
- HTTP 路徑獲得 `previous_response_id` + delta 能力（不再依賴 WS）

## Capabilities

### New Capabilities

- **Codex zero-config plugin**: 可從 opencode 分離的獨立 plugin 檔案包
- **Native Responses API client**: 直接對接 OpenAI API，保留完整 protocol fingerprint
- **HTTP delta**: `previous_response_id` over HTTP，不依賴 WS 連線持續

### Modified Capabilities

- **AI SDK 模塊化**: 拆分為 shared utilities（可重用）+ provider adapters（per-provider）
- **Codex model management**: 從 provider.ts 搬進 plugin 內部

## Impact

- **Codex provider**: 完整重構，行為不變但架構改善
- **其他 provider**: 不受影響
- **AI SDK 層**: codex 不再使用 `@ai-sdk/openai`，其他 provider 繼續用
- **上游追蹤**: 直接比對 refs/codex 的 protocol 行為，不需要穿透 AI SDK 適配層
