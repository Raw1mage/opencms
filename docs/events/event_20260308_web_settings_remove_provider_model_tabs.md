# Event: Remove Provider/Model Tabs from Web Settings

Date: 2026-03-08
Status: In Progress

## 1. 需求

- webapp 設定視窗不再顯示「提供者」頁面。
- webapp 設定視窗不再顯示「模型」頁面。
- 只移除 web settings 入口，不影響其他管理入口（如模型管理員、帳號頁）。

## 2. 範圍

### IN

- `packages/app/src/components/dialog-settings.tsx`
- 必要時同步 `docs/ARCHITECTURE.md`

### OUT

- 不刪除底層 `settings-providers.tsx` / `settings-models.tsx` 元件
- 不修改模型管理員或帳號管理流程
- 不重構整體 settings framework

## 3. 任務清單

- [x] 確認 web settings tabs 與呼叫點
- [x] 移除 provider / model tabs 與對應 content mount
- [x] 執行 targeted validation
- [x] 檢查 Architecture Sync 是否需要更新

## 4. Debug Checkpoints

### Baseline

- `packages/app/src/components/dialog-settings.tsx` 目前在 server 區塊顯示 `providers`、`models`、`accounts` 三個 tabs。
- 呼叫點只看到 `DialogSettings()` 與 `DialogSettings initialTab="accounts"`，沒有對 `providers/models` 的外部深連結依賴。

### Execution

- `packages/app/src/components/dialog-settings.tsx` 移除 `SettingsProviders` / `SettingsModels` import。
- `DialogSettingsProps.initialTab` 收斂為 `general | shortcuts | accounts`。
- settings 左側 server 區塊只保留 `accounts` tab。
- 移除 `providers` / `models` 對應的 `Tabs.Content` mount，避免進入設定視窗時再顯示這兩頁。

### Validation

- `bunx tsc --noEmit -p packages/app/tsconfig.json` ✅
- `bunx eslint packages/app/src/components/dialog-settings.tsx` ✅
- Architecture Sync: Verified (No doc changes)
  - 比對依據：本次僅調整 web settings 視窗的 tabs 顯示與 mount 範圍，未新增架構邊界、模組分層或新的 runtime contract。
