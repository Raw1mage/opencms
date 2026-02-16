# Refactor Plan: Antigravity Protocol Sync (2026-02-11) [DONE]

## 0. 狀態 (Status)

✅ **已完成 (Completed)** - 2026-02-11
所有核心邏輯（4-Pass Tool ID, Thinking Recovery, Sanitization）均已驗證存在於 `request.ts` 與 `request-helpers.ts` 中。

## 1. 目的 (Objective)

同步本地 `antigravity` 插件與上游 Submodule (v1.4.6) 的對話協定實作。特別是針對 Claude 模型的 Tool ID 匹配與 Thinking Recovery 邏輯，確保模擬行為與正版完全一致，避免依賴後端容錯。

## 2. 變更範圍 (Scope)

- **主要變更**: `packages/opencode/src/plugin/antigravity/plugin/request.ts`
- **輔助變更**: `packages/opencode/src/plugin/antigravity/plugin/request-helpers.ts` (同步最新的 Helper 邏輯)

## 3. 核心邏輯更新 (Key Changes)

### 3.1 Claude Tool ID 4-Pass 處理 (request.ts)

將目前單一的 `applyToolPairingFixes` 呼叫分解為與上游一致的四步驟：

1. **Pass 1**: 為所有 `functionCall` 分配唯一的 `tool-call-id`。
2. **Pass 2**: 建立 `pendingCallIdsByName` 佇列，依序 (FIFO) 為 `functionResponse` 分配 ID。
3. **Pass 3**: 呼叫 `fixToolResponseGrouping` 進行孤兒恢復 (Orphan Recovery)。
4. **Pass 4**: 呼叫 `validateAndFixClaudeToolPairing` 修正訊息陣列格式。

### 3.2 Thinking Recovery (Last Resort)

在 `request.ts` 中加入「最後手段」的恢復邏輯：

- 當檢測到 `thinking_block_order` 錯誤或上下文損壞時，自動關閉當前 Turn 並開啟新 Turn。
- 清除該 Session 的簽名快取。

### 3.3 跨模型 Metadata 清理 (Cross-Model Sanitization)

優化 `sanitizeCrossModelPayloadInPlace` 在 `request.ts` 中的執行位置，確保在傳送給 Claude 之前完全剝離 Gemini 的簽名資訊。

## 4. 預期效果 (Expected Results)

- 提高在複雜多輪對話中的穩定性。
- 解決 Claude 模型偶爾出現的 `Expected thinking but found text` 或 `Tool use without response` 錯誤。
- 對齊官方最新版本的行為模式。

## 5. 驗證計畫 (Verification)

- 執行 `npm test` 確保現有測試通過。
- 檢查代碼邏輯是否與 `refs/opencode-antigravity-auth/src/plugin/request.ts` (Line 1206-1304) 對齊。
