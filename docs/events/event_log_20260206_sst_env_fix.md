#### 功能：修正 SST 環境變數宣告錯誤

**需求**

- 解決 `packages/console/app/resource/resource.node.ts` 中 `ResourceBase.CLOUDFLARE_API_TOKEN` 和 `ResourceBase.CLOUDFLARE_DEFAULT_ACCOUNT_ID` 未宣告的型別錯誤。

**範圍**

- IN：`packages/console/app/sst-env.d.ts`。

**方法**

- 在 `packages/console/app/sst-env.d.ts` 中，為 `CLOUDFLARE_API_TOKEN` 和 `CLOUDFLARE_DEFAULT_ACCOUNT_ID` 添加型別宣告。
- 由於 `edit` 工具的行為問題，將直接使用 `write` 工具覆寫檔案內容。

**任務**

1. [x] 分析專案結構與類型檢查配置 (tsconfig.json, turbo.json)
2. [x] 建立 event_20260206_typecheck_codereview.md 紀錄文件
3. [x] 讀取 packages/console/app/sst-env.d.ts
4. [x] 修改 packages/console/app/sst-env.d.ts 添加環境變數宣告
5. [ ] 執行全域型別檢查 (bun turbo typecheck) 並記錄錯誤
6. [ ] 針對 src/session, src/provider 等核心目錄進行代碼審查 (Code Review)
7. [ ] 分析效能風險與潛在邏輯錯誤
8. [ ] 產出健檢報告與優化建議

**CHANGELOG**

- `packages/console/app/sst-env.d.ts`: 添加 `CLOUDFLARE_API_TOKEN` 和 `CLOUDFLARE_DEFAULT_ACCOUNT_ID` 的型別宣告。

**待解問題**

- 無。
