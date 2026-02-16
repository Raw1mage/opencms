# 重構計畫：2026-02-07 (Submodule Update)

## 摘要 (Summary)

本次任務專注於處理 `opencode-antigravity-auth` 套件更新 (v1.4.6) 所帶來的架構影響。

- **策略**：重構移植 (Refactor Port)
- **目標**：修復工具優先權評分邏輯，確保 `google_search` 正常運作。

## 行動 (Actions)

| Commit | Action | Notes |
| :----- | :----- | :---- |
| `28f46c2` (Submodule) | **重構移植 (Refactor Port)** | 更新 `src/tool/registry.ts` 以匹配新版本 v1.4.6，修復工具評分失效問題。 |

## 執行佇列 (Execution Queue)

1. [ ] **重構移植**：修改 `src/tool/registry.ts`。
   - 將 `refs/opencode-antigravity-auth-1.4.3` 更新為 `refs/opencode-antigravity-auth-1.4.6` (或更通用的 `refs/opencode-antigravity-auth`)。
2. [ ] **驗證**：執行 `tsc` 確保無型別錯誤。
