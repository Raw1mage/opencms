#### 功能：GMI Cloud UI 優化與清理

**需求**

- 新增 GMI Cloud 的 i18n 說明文字。
- 清理開發期間留下的偵錯日誌。
- 驗證 UI 呈現與模型可見性。

**範圍**

- IN：`packages/app/src/i18n/en.ts`, `packages/app/src/i18n/zht.ts`, `src/provider/provider.ts` | OUT：其他無關的 Provider 設定。

**方法**

- 在 `en.ts` 與 `zht.ts` 中加入 `dialog.provider.gmicloud.note`。
- 移除 `src/provider/provider.ts` 中的 `debugCheckpoint` 與 `gmicloud` 相關的暫時日誌。

**任務**

1. [x] 更新 `packages/app/src/i18n/en.ts`
2. [x] 更新 `packages/app/src/i18n/zht.ts`
3. [x] 移除 `src/provider/provider.ts` 中的偵錯日誌
4. [x] 更新 `packages/app/src/components/dialog-select-provider.tsx` 以顯示說明
5. [x] 修正 TUI `DialogAdmin` 的 `Tab` 鍵衝突，改用 `p` 鍵切換頁面
6. [x] 將 `gmicloud` 注入 `ModelsDev.get()` 以確保其在未配置時仍可見
7. [x] 驗證模型可見性
8. [x] 更新 `docs/DIARY.md`

**待解問題**

- 無
