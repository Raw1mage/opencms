# Event: Gemini Submodule Refactor & Integration

Date: 2026-02-08
Status: Planning

## 1. 需求分析
目標是將 `opencode-gemini-auth` 子模組中的關鍵更新手動移植到 `src/plugin/gemini-cli/plugin/`。

### 關鍵更新點
- **Thinking Capability**: 支援 Gemini 3 的思考模式配置。
- **Usage Metadata**: 改進 Token 使用量統計的擷取 (從 Response Header 傳回)。
- **Enhanced Error Handling**: 更好的配額 (Quota) 與預覽權限 (Preview Access) 錯誤訊息處理。
- **SSE Transformation**: 支援將 Gemini SSE 格式轉換為標準回應。

### 限制與排除
- **排除**: 捨棄子模組內部的帳號切換與速率限制邏輯。
- **架構**: 必須維持 CMS 的 `Rotation3D` 與全域 `Account` 管理架構。

## 2. 執行計畫
- [ ] **Step 1: 更新 `request-helpers.ts`**
  - 移植 `ThinkingConfig`, `GeminiUsageMetadata` 定義。
  - 移植 `normalizeThinkingConfig`, `enhanceGeminiErrorResponse`, `rewriteGeminiPreviewAccessError` 等輔助函式。
- [ ] **Step 2: 更新 `request.ts`**
  - 移植 `transformOpenAIToolCalls` 與 `addThoughtSignaturesToFunctionCalls`。
  - 更新 `prepareGeminiRequest` 以處理思考配置。
  - 更新 `transformGeminiResponse` 以支援增強的錯誤訊息與 Usage Header。
- [ ] **Step 3: 驗證**
  - 執行 `bun run typecheck`。

## 3. 關鍵決策
- **Manual Porting**: 由於 `cms` 分支對 Plugin 進行了架構調整 (3-way split)，不能使用 `git merge`，必須手動對齊程式碼。
