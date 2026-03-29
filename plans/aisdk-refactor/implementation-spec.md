# Implementation Spec

## Goal

- 將 codex provider 的進階 Responses API 功能從 CUSTOM_LOADER（CodexLanguageModel）搬到 AI SDK path 的 custom fetch interceptor，保留 AI SDK 的完整 stream pipeline

## Scope

### IN

- 分析 @ai-sdk/openai responses adapter 的 request body 構建
- 搬遷 Responses API 功能到 fetch interceptor body transform
- 停用 CUSTOM_LOADER
- 驗證所有功能在 AI SDK path 正常運作

### OUT

- WebSocket transport（廢棄）
- C binary transport（廢棄）
- AI SDK 上游修改

## Assumptions

- @ai-sdk/openai 的 `sdk.responses()` 已能正確構建 Responses API 的基本 request body
- custom fetch interceptor 的 additive body transform 不會破壞 AI SDK 構建的 body
- AI SDK 的 tool loop + lifecycle events 在 codex provider 上正常運作（已驗證）

## Stop Gates

- SG-1: 如果 @ai-sdk/openai 的 responses adapter 不支援某個必要欄位（例如 `input` items 格式不對），需要評估 workaround
- SG-2: 如果 fetch interceptor 的 body transform 破壞了 AI SDK 的 request（例如覆蓋了必要欄位），需要改為 additive-only

## Critical Files

- `packages/opencode/src/plugin/codex.ts` — fetch interceptor 擴充
- `packages/opencode/src/provider/provider.ts` — CUSTOM_LOADER 停用
- `node_modules/@ai-sdk/openai/dist/index.js` — 參考分析
- `node_modules/ai/dist/index.js` — 參考分析

## Structured Execution Phases

### Phase 1: 分析（不改程式碼）
分析 @ai-sdk/openai 的 responses adapter 和現有 fetch interceptor，文件化 gap

### Phase 2: 搬遷（fetch interceptor body transform）
把 context_management、encrypted_content、store、service_tier 加到 fetch interceptor

### Phase 3: 停用 + 驗證
停用 CUSTOM_LOADER，全面走 AI SDK path，驗證所有功能

### Phase 4: 清理
評估並處理廢棄程式碼

## Validation

- codex provider tool call loop 正常（包含 subagent）
- prompt_cache_key 出現在 request body
- context_management 出現在 request body
- text streaming + finish lifecycle 正常
- autonomous orchestrator 行為正常
- typecheck 0 new errors

## Handoff

- Build agent must read this spec first.
- Build agent must read design.md 的 AI SDK 架構分析。
- 重要：Phase 1 是純分析，不改程式碼。Phase 2 才開始改。
