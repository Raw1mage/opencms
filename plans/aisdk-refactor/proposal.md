# Proposal

## Why

codex provider 的 CUSTOM_LOADER（CodexLanguageModel）試圖取代 AI SDK 的 25,000 行程式碼，只實作了 prompt 格式轉換和 stream 轉發，缺少 tool loop、schema validation、retry、lifecycle events 等 15+ 項功能。導致 tool call 後無回程、subagent 卡死、stream lifecycle 不完整。

根本原因：沒有先理解 AI SDK 做了什麼就去取代它。

## Original Requirement Wording (Baseline)

- "我想要 codex 的進階功能（incremental context, cache, compaction, encrypt）"
- "AI SDK 顯然是一個很完整現成的一大包功能，直接離開它似乎太冒然了"
- "不要浪費分析成果，把查到的架構原理先文件化"

## Effective Requirement Description

1. 文件化 AI SDK 的完整架構和 codex provider 的正確整合方式
2. 確定哪些 Responses API 功能可以透過 custom fetch body transform 實作（不離開 AI SDK）
3. 確定哪些功能真的需要 custom loader（如果有的話）
4. 制定漸進式重構路徑

## Scope

### IN

- AI SDK 架構文件化（streamText pipeline、tool loop、transform chain）
- @ai-sdk/openai Responses API adapter 分析
- codex custom fetch interceptor 能力盤點
- CodexLanguageModel 功能拆解：哪些搬到 fetch interceptor、哪些廢棄
- 重構路徑規劃

### OUT

- 實際程式碼修改（本 plan 只做分析和規劃）
- 其他 provider 的重構
- AI SDK 上游貢獻

## What Changes

- 產出架構文件：AI SDK 層級分析、codex 整合方式
- 產出決策記錄：custom loader vs fetch interceptor
- 產出 tasks.md：漸進式重構步驟

## Capabilities

### Modified Capabilities

- codex provider：從 custom loader 回到 AI SDK path + enhanced fetch interceptor

## Impact

- `packages/opencode/src/provider/codex-language-model.ts` — 可能大幅簡化或廢棄
- `packages/opencode/src/provider/codex-websocket.ts` — 可能廢棄
- `packages/opencode/src/plugin/codex.ts` — fetch interceptor 擴充
- `packages/opencode/src/provider/provider.ts` — CUSTOM_LOADER 簡化
