# Event: Claude-CLI OAuth Fix & Provider Migration

**Date:** 2026-02-14
**Status:** Completed
**Topic:** Fix "invalid_scope" during token refresh and finalize migration from legacy "anthropic" to "claude-cli".

## 1. 需求分析與問題診斷

### 1.1 問題描述

用戶回報在使用 Claude-CLI (Anthropic Subscription) 時，Token Refresh 失敗並回傳錯誤：
`Error: Token refresh failed (400): {"error": "invalid_scope", "error_description": "The requested scope is invalid, unknown, or malformed."}`

### 1.2 根本原因分析 (RCA)

透過對官方 Claude CLI (`v2.1.37`) 二進位檔進行逆向工程，發現其在不同階段使用不同的 Scope 組合：

- **Authorization (初次授權)**: 包含 `org:create_api_key` 以及其他 user-\* scopes。
- **Refresh Token**: **不包含** `org:create_api_key`。

CMS 之前的實作在 Refresh 時發送了完整的 Authorization scopes，導致 Anthropic OAuth Server 拒絕請求。

## 2. 執行項目

### 2.1 OAuth 修正

- 更新 `packages/opencode/src/plugin/anthropic.ts` 中的 `REFRESH_SCOPES`。
- 移除了 refresh 請求中的 `org:create_api_key`。
- 驗證後確認與官方 CLI 行為一致。

### 2.2 Provider 清理

- 全面移除代碼中硬編碼的 `anthropic` 作為 Provider ID 的引用。
- 更新以下模組使用 `claude-cli`：
  - `packages/opencode/src/account/index.ts` (移除舊遷移邏輯)
  - `packages/opencode/src/session/llm.ts` (User-Agent 判斷)
  - `packages/opencode/src/provider/default-model.ts` (訂閱優先權)
  - `packages/opencode/src/server/routes/rotation.ts` (模型選擇優先權)
- 保留 `anthropic` 僅用於：
  - 模型特徵檢測 (e.g., `model.id.includes("anthropic")`)
  - SDK 識別碼 (e.g., `@ai-sdk/anthropic`)

### 2.3 知識轉移 (Skill Update)

- 更新 `.opencode/skills/refactor-anthropic/SKILL.md`。
- 加入了 Scope 分組邏輯的詳細說明。
- 提供了快速分析 CLI 二進位檔的 `node` 指令腳本。

## 3. 驗證結果

- [x] OAuth Refresh 請求結構符合官方定義。
- [x] 系統內部再無名為 `anthropic` 的活動 Provider (統一為 `claude-cli`)。
- [x] 測試案例 `anthropic.test.ts` 通過基本驗證。

## 4. 關鍵決策

- **Provider 命名規範**: 確立 `claude-cli` 為 Anthropic 訂閱帳號的唯一識別碼，以區分未來的 API Provider。
- **逆向工程方法**: 確立了透過分析安裝環境中的二進位檔來驗證協議特徵的 SOP。
