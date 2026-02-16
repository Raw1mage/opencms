#### 功能：修復 GMI Cloud 整合後的 UI 崩潰問題

**需求**

- 解決 Admin Panel 中 "Providers" 標籤無法顯示的問題。
- 確保 GMI Cloud provider 正確顯示在 "Popular" 列表中。
- 清理偵錯日誌。

**範圍**

- IN：`packages/app/src/components/settings-providers.tsx`, `packages/app/src/hooks/use-providers.ts`, `src/provider/provider.ts` | OUT：其他無關 UI 元件。

**方法**

- [ANALYSIS] 檢查 `SettingsProviders` 中的 `createMemo` 邏輯，特別是排序與過濾部分。
- [EXECUTION] 增加錯誤處理或守衛語句，防止 `undefined` 導致的崩潰。
- [EXECUTION] 移除後端 `src/provider/provider.ts` 中的 `debugCheckpoint`。
- [EXECUTION] 驗證 `DialogConnectProvider` 對新 provider 的處理。

**任務**

1. [ ] 在 `SettingsProviders.tsx` 增加更嚴謹的守衛邏輯。
2. [ ] 在 `use-providers.ts` 確保 `providers()` 恆不為空。
3. [ ] 移除後端多餘的 `debugCheckpoint`。
4. [ ] 檢查並補齊可能缺失的翻譯 (i18n)。

**待解問題**

- 具體的崩潰調用棧 (目前僅能通過靜態分析推斷)。
