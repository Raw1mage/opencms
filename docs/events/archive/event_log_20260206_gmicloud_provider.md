#### 功能：增加 GMI Cloud Provider 支援

**需求**

- 系統內定支援 "gmicloud" provider。
- 支援環境變數 `GMI_API_KEY`。
- 預設包含 `deepseek-ai/DeepSeek-R1` 模型。
- 與 OpenAI API 完全相容。
- 在 UI 中顯示 GMI Cloud 圖示並列為熱門 provider。

**範圍**

- IN：`src/provider/provider.ts`, `packages/app/src/hooks/use-providers.ts`, `packages/ui/src/components/provider-icons/types.ts`, `packages/ui/src/components/provider-icons/sprite.svg`
- OUT：不包含 OAuth 支援（僅 API Key）。

**方法**

- 在 `src/provider/provider.ts` 中註冊 `gmicloud` 並定義預設模型。
- 在 `packages/ui/src/components/provider-icons/` 中增加 GMI Cloud 圖示。
- 在 `packages/app/src/hooks/use-providers.ts` 中將其加入 `popularProviders`。

**任務**

1. [x] 更新 `packages/ui/src/components/provider-icons/types.ts` 增加 `gmicloud`。
2. [x] 更新 `packages/ui/src/components/provider-icons/sprite.svg` 增加 GMI Cloud 圖示（使用簡約雲朵設計）。
3. [x] 更新 `src/provider/provider.ts`：
   - 在 `CUSTOM_LOADERS` 增加 `gmicloud`。
   - 在 `state` 初始化中建立 `database["gmicloud"]` 並加入模型。
4. [x] 更新 `packages/app/src/hooks/use-providers.ts` 將 `gmicloud` 加入熱門列表。
5. [x] 更新 `docs/DIARY.md` 記錄變更。

**待解問題**

- 無。
