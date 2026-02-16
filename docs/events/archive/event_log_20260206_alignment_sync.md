#### 功能：Provider 系統清理與顯示優化 (Phase 2.1) - 深度清理與對齊修正

**需求**

- 修正 `DialogAdmin` Activities 分頁的 UI 對齊問題。
- 同步 `opencode models` 命令中的 Provider 命名（統一使用 `google-api`）。
- 移除 `src/cli/cmd/models.ts` 中殘留的 `google API-KEY` 命名。

**範圍**

- IN：`src/cli/cmd/tui/component/dialog-admin.tsx`, `src/cli/cmd/models.ts`
- OUT：非 CLI/TUI 的核心 provider 協議定義（如 `packages/console` 下的部分定義暫不更動以維持相容性）。

**方法**

- **UI 對齊**：調整 `DialogAdmin` 的標頭字串，確保其與 `padEnd(13)` 和 `padEnd(19)` 的資料列完全對齊。
- **命名同步**：將 `models.ts` 中的 `google API-KEY` 取代為 `google-api`，並使用 `Account.getProviderLabel` 進行顯示。

**任務**

1. [x] 修正 `src/cli/cmd/tui/component/dialog-admin.tsx` 的 Activities 標頭對齊。
2. [x] 重構 `src/cli/cmd/models.ts` 以使用統一的 `google-api` ID。
3. [x] 驗證全域 `google` vs `google-api` 的使用情況（修正 `provider.ts`, `rotation.ts`, `tests`）。

**待解問題**

- 無
