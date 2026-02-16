# Event: 2026-02-12 Antigravity Types Refactor

Date: 2026-02-12
Status: Done

## 1. 需求分析
- 目標：消除 `packages/opencode/src/plugin/antigravity/` 目錄下的 `any` 型別濫用（170+ 處）。
- 範圍：`request-helpers.ts`, `request.ts`。
- 限制：不破壞現有功能，確保 `typecheck` 通過。

## 2. 執行計畫
- [x] 分析 `any` 分布與用途。
- [x] 建立 `packages/opencode/src/plugin/antigravity/plugin/types.ts` 定義共用介面。
  - `JsonSchema`
  - `GeminiPart`, `GeminiContent`, `GeminiCandidate`
  - `AntigravityApiBody`, `AntigravityRequestPayload`
- [x] 重構 `request-helpers.ts`：
  - 引入新 types。
  - 更新 JSON Schema helper functions 簽章 (`JsonSchema | JsonSchema[]`)。
  - 更新 thinking/tool processing functions 簽章。
- [x] 重構 `request.ts`：
  - 引入新 types。
  - 更新 request preparation logic 使用 `AntigravityRequestPayload`。
- [x] 驗證：
  - 執行 `bun run typecheck` 確保無 regression。

## 3. 關鍵決策與發現
- `JsonSchema` 定義是遞迴的，且 helper functions 處理遞迴 array，因此需要 `JsonSchema | JsonSchema[]` 作為參數與回傳型別，這解決了大部分 `as any` casting 的需求。
- `AntigravityRequestPayload` 統一了 request body 的型別，消除了大量 `Record<string, unknown>` 和 `any` casting。
- 透過 `types.ts` 集中管理型別，避免 `request-helpers.ts` 與 `request.ts` 之間的循環依賴或重複定義。

## 4. 遺留問題 (Pending Issues)
- 部分低層級的 content processing (如 `filterUnsignedThinkingBlocks`) 仍保留少量 `any`，因為需要處理來自不同 provider 的非標準化 raw response，過度強型別可能導致 runtime error 或 logic bug。
