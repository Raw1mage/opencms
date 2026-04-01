# Event: Web layout and model manager regressions

## 需求

- Web 預設載入時不要自動開啟任何空的 tab / pane，包含檔案列表與 Git 變動側欄。
- 「模型管理員」視窗必須保留可拖曳能力。
- 「模型管理員」provider list 必須恢復眼睛圖示，且眼睛語意為 Favorites membership。
- Favorites 眼睛切換狀態必須持久化，重開後不可回復原狀。

## 範圍

### IN

- `/home/pkcs12/projects/opencode/packages/app/src/context/layout.tsx`
- `/home/pkcs12/projects/opencode/packages/app/src/context/layout.test.ts`
- `/home/pkcs12/projects/opencode/packages/app/src/components/dialog-select-model.tsx`
- `/home/pkcs12/projects/opencode/packages/app/src/components/model-selector-state.ts`
- `/home/pkcs12/projects/opencode/packages/app/src/components/model-selector-state.test.ts`

### OUT

- 不改動 file-open 後主動開 tab 的既有流程。
- 不改動後端 provider/account/runtime 契約。
- 不恢復不透明、使用者不可控的 disabled-list provider 阻擋邏輯。
- 不再把眼睛圖示視為 hidden toggle；它只控制是否屬於 Favorites。

## 任務清單

- [x] 關閉 web 預設 auto-open file pane / Git changes sidebar
- [x] 以 migration 重設既有 persisted layout 的預設開啟狀態
- [x] 修復 model manager dialog 實際拖曳位置失效
- [x] 恢復 provider list 眼睛圖示與 Favorites 切換語意
- [x] 修復 Favorites 切換未持久化
- [x] 執行最小可行驗證（typecheck + 相關測試）

## Debug Checkpoints

### Baseline

- Web 預設進入頁面時，會自動打開空的檔案 pane 與 Git 變動側欄，造成初始畫面雜訊。
- 先前修補造成 model manager provider list 的眼睛圖示回歸消失，後續又一度被誤接成 hidden toggle 而非 Favorites toggle。
- 使用者要求 model manager 視窗拖曳保留；實際檢查後發現 drag 綁定點不在真正的頂部 header，導致看似有邏輯但實際拖不動。
- Favorites 切換雖然當下可見，但重開後又回到預設值，表示 persisted favorites 與初始化流程不一致。

### Implementation

- `packages/app/src/context/layout.tsx`
  - `review.panelOpened` 與 `fileTree.opened` 預設值改為 `false`。
  - 對應 accessor/fallback 預設值也改為 `false`。
  - 新增 `migrateLayoutState(...)`，並將 persisted layout 版本升為 `layout.v10`，主動關閉舊資料中的 file pane / tool sidebar 開啟狀態。
- `packages/app/src/context/layout.test.ts`
  - 新增 migration 測試，驗證 persisted layout 會把 file pane 與 tool sidebar 關閉。
- `packages/app/src/components/dialog-select-model.tsx`
  - 將 provider 本地狀態從 `hiddenProviders` 改為 `favoriteProviders`。
  - 新增 `MODEL_MANAGER_FAVORITE_PROVIDERS_STORAGE_KEY`，避免沿用錯誤 hidden 語意。
  - provider list 維持 `enabled` / `onToggleEnabled` 傳遞，但眼睛語意改為 Favorites membership。
  - `favorites` 模式只顯示 favorites providers；`all` 模式顯示全部 providers。
  - 新增 `resolveDialogHeader()`，將 `startDrag` 綁到真正的 `[data-slot="dialog-header"]`，並補上 header 的 `cursor-move` / `select-none` 樣式，修復實際拖曳位置失效。
  - `favoriteProviders` 初始化改為先用靜態預設，再於 mounted/hydration 階段重新從 localStorage 載入，避免被預設 `popularProviders` 覆蓋 persisted 值。
- `packages/app/src/components/model-selector-state.ts`
  - `buildProviderRows(...)` 改用 `favoriteProviders`，`ProviderRow.enabled` 反映是否屬於 Favorites。
  - 新增 `loadFavoriteProvidersFromStorage(...)`，明確區分：storage key 不存在才 fallback 到預設 favorites；若 key 已存在且為空陣列/自訂值則保留 persisted 值。
- `packages/app/src/components/model-selector-state.test.ts`
  - 更新/補充 provider row 測試，驗證 user-controlled favorites 語意與 favorites storage loader 行為。

### Root Cause

- 問題一：layout 預設值與 persisted state fallback 讓 Web 初始畫面自動展開不必要 pane。
- 問題二：provider list 在先前 RCA 簡化過程中，把「不透明 disabled list」與使用者可控制狀態混為一談，先導致眼睛圖示功能回歸消失，之後又短暫被接成 hidden toggle，而非 Favorites toggle。
- 問題三：model manager 視窗拖曳能力除了曾被誤判為應移除外，後續即使邏輯被保留，drag event 仍綁在內層內容列而非真正 header，導致互動表面存在但實際不可用。
- 問題四：Favorites persisted 值在初始化/hydration 時被預設 `popularProviders` 覆蓋，導致切換雖然寫入 storage，但重開後仍恢復原狀。

### Validation

- `bun run typecheck`（workdir=`/home/pkcs12/projects/opencode/packages/app`）✅
- `bun test /home/pkcs12/projects/opencode/packages/app/src/context/layout.test.ts` ✅（8 pass / 0 fail）
- `bun test /home/pkcs12/projects/opencode/packages/app/src/components/model-selector-state.test.ts` ✅（18 pass / 0 fail）
- Architecture Sync: Verified (No doc changes)
  - 依據：本次僅調整 Web layout 預設 state 與 model manager 前端互動/可見性邏輯，未改變長期模組邊界、資料流主幹、runtime 狀態機或後端契約。
