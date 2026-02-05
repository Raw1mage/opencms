#### 功能：Provider 系統清理與顯示優化 (Phase 2)

**需求**

- 修正 `Account.getDisplayName` 對於 `cli` 帳號（Gemini CLI）顯示不友善的問題。
- 在 Model Activities 儀表板中使用友善的 Provider 名稱而非原始 ID。
- 清理程式碼中殘留的 `providerId` (大寫 ID) 命名。
- 確保系統中完全移除 legacy `google` ID 的使用，統一為 `google-api`。

**範圍**

- IN：`src/account/index.ts`, `src/cli/cmd/tui/component/dialog-model-health.tsx`, `src/cli/cmd/tui/component/dialog-admin.tsx`, `docs/events/event_2026-02-05.md`, `script/seed-e2e.ts`, `scripts/changelog.ts`

**方法**

- `src/account/index.ts`：更新 `getDisplayName`，在 Step 8 排除 `cli` 以便進入 Step 9 的映射表。
- `src/cli/cmd/tui/component/dialog-model-health.tsx` & `dialog-admin.tsx`：實作 Provider 標籤轉換邏輯，讓 Activities 列表顯示如 "Google API", "OpenAI" 等。
- 全域搜尋並取代殘留的 `providerId`。

**任務**

1. [ ] 更新 `src/account/index.ts` 修復 `cli` 帳號顯示名稱。
2. [ ] 在 `src/account/index.ts` 新增 `getProviderLabel` 工具函數供全域使用。
3. [ ] 修改 `src/cli/cmd/tui/component/dialog-model-health.tsx` 使用 `Account.getProviderLabel`。
4. [ ] 修改 `src/cli/cmd/tui/component/dialog-admin.tsx` 使用 `Account.getProviderLabel`。
5. [ ] 清理 `docs/` 與 `scripts/` 中的 `providerId`。
6. [ ] 更新 `docs/DIARY.md`。

**待解問題**

- 無
