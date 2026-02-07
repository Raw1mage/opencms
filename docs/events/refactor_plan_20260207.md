# Refactor Plan: 2026-02-07 (Submodule Integration)

## 摘要 (Summary)

本次任務旨在將 submodule `refs/opencode-antigravity-auth` 的更新 (v1.4.5) 安全整合至 `cms` 主程式。

- **目前狀態**: Submodule 已指向新 commit `ed5cb23` (v1.4.5)。
- **主要問題**: `src/tool/registry.ts` 中硬編碼了舊版本號 (`1.4.3`)，導致工具優先權評分失效。
- **風險等級**: **LOW** (主要為版本字串修正，不涉及核心架構變更)。

## 變更分析 (Analysis)

| Submodule | 變更內容 | 影響範圍 |
| :--- | :--- | :--- |
| `opencode-antigravity-auth` | 新增 `openai_quota.ts`，優化 `rotation3d` | `src/tool/registry.ts` (工具評分邏輯) |

## 執行計畫 (Execution Queue)

1. [ ] **修正**: 修改 `src/tool/registry.ts`。
   - 將 `refs/opencode-antigravity-auth-1.4.3` 改為模糊比對或更新為 `1.4.5`，以確保 `google_search` 工具能正確獲得高優先權。
2. [ ] **驗證**: 執行 `tsc` 確保型別檢查通過。
3. [ ] **測試**: 簡單驗證工具註冊邏輯 (透過 log 或單元測試)。

## 待確認事項 (Questions)

- 是否有其他檔案依賴特定版本路徑？(已透過 grep 初步排除)
