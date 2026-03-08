# Event: web sync ssot refactor plan

Date: 2026-03-08
Status: Done

## 需求

- 針對 webapp 前端同步機制中「多重事實來源」問題做結構化盤點。
- 說明 stale refresh / optimistic rollback / bootstrap overwrite 類問題的根因。
- 提出可分階段落地的 SSOT refactor plan，避免同類 bug 在 provider / model / account / permission 流程反覆出現。

## 範圍

### IN

- `/home/pkcs12/projects/opencode/packages/app/src/context/global-sync.tsx`
- `/home/pkcs12/projects/opencode/packages/app/src/context/global-sync/bootstrap.ts`
- `/home/pkcs12/projects/opencode/packages/app/src/context/global-sync/event-reducer.ts`
- `/home/pkcs12/projects/opencode/packages/app/src/context/models.tsx`
- `/home/pkcs12/projects/opencode/packages/app/src/components/dialog-select-model.tsx`
- `/home/pkcs12/projects/opencode/packages/app/src/components/settings-providers.tsx`
- `/home/pkcs12/projects/opencode/packages/app/src/components/dialog-custom-provider.tsx`
- 風險盤點與重構路線

### OUT

- 本輪不直接進行大規模同步層重寫
- 不修改 backend event contract / API schema

## 任務清單

- [x] 盤點 web sync 的多重事實來源與 refresh 路徑
- [x] 標出高風險資源類型與具體檔案位置
- [x] 形成分階段重構提案

## Debug Checkpoints

### Baseline

- 最近已觀察到 provider toggle 在 model selector 中出現 optimistic state 被過時 refresh 覆蓋的現象。
- 使用者明確指出「多重事實來源是最討人厭的事」，希望進一步朝架構優化處理，而非只補單點 bug。

### Execution

- 檢查 `globalSync.updateConfig()`：
  - 目前會先 `global.config.update`，再執行 `bootstrap()`。
  - `bootstrap()` 會重抓 `config / provider / provider_auth / account_families / project`，對小 mutation 來說過重。
- 檢查 backend `Config.updateGlobal()`：
  - 寫入 global config 後會 `Instance.disposeAll()`，並送出 `global.disposed` 事件。
  - web 前端在 `event-reducer.ts` 中對 `global.disposed` 直接 `refresh()`，因此一次小更新可能引發額外全域 reload。
- 檢查 provider visibility flow：
  - `settings-providers.tsx` 仍採 `globalSync.set("config", ...) + globalSync.updateConfig(...)` 雙寫模式。
  - `dialog-select-model.tsx` 先前也有同型問題；本輪已局部補上 optimistic overlay。
- 檢查 model preferences flow：
  - `context/models.tsx` 內同時存在 local persisted store、remote read、debounced remote write、normalization effect。
  - 該區域目前仍有 local store / remote snapshot / timer write 三種事實來源，雖然比 global config path 局部，但一致性風險仍高。
- 檢查 custom provider connect flow：
  - `dialog-custom-provider.tsx` 將 auth 設定與 config 更新串在一起，仍依賴 `globalSync.updateConfig(...)` 來收斂。

### Validation

- 初版盤點階段未修改 runtime code；後續 Phase 1 已開始實作，詳見下方進度區塊。
- Architecture Sync: Verified (No doc changes)
  - 依據：盤點與 Phase 1 實作皆未改變實際 architecture 邊界與 runtime data flow 分層，只是收斂 webapp client-side ownership。

## Phase 1 實作進度（disabled_providers action layer）

### 實作內容

- `packages/app/src/context/global-sync.tsx`
  - 新增 `configActions.disabledProviders()` / `isProviderDisabled()` / `setDisabledProviders()` / `setProviderDisabled()`。
  - 將 `disabled_providers` optimistic overlay 提升到 `globalSync` 層，而非留在單一 component。
  - 為 overlay 加入 mutation version guard，避免較舊 request failure/success 對較新的 optimistic state 造成回滾污染。
  - `updateConfig()` 若 patch 內含 `disabled_providers`，也會沿用相同 overlay / rollback 邏輯，讓 mixed config updates 不會繞過保護。
- `packages/app/src/components/settings-providers.tsx`
  - 改讀 `globalSync.configActions.*`，移除 component 內 `globalSync.set("config") + updateConfig()` 雙寫。
- `packages/app/src/components/dialog-select-model.tsx`
  - 移除本地 `optimisticDisabledProviders`，改讀 globalSync action layer。
  - provider toggle 現在是「shared disabled-provider resource + scroll preservation」組合，而不是單頁補丁。
- `packages/app/src/components/dialog-custom-provider.tsx`
  - 驗證與 disabled-provider 推導改讀 action layer 的 effective state，避免讀到 stale raw config。

### 本階段收益

- `disabled_providers` 至少在 webapp 端已有單一 client-side effective state。
- provider settings 頁與 model selector 不再各自維護半套 optimistic 邏輯。
- 後續可依樣畫葫蘆擴充到 permission / model preferences / account active state。

### 本階段仍未完成

- `global.disposed` 仍是粗粒度 refresh；尚未拆成 resource-scoped refresh。
- `dialog-custom-provider.tsx` 仍有 mixed config update 路徑，只是已納入 disabled-provider overlay 保護。
- model preferences / active account 尚未進 action layer。

### Phase 1 Validation

- `bunx tsc --noEmit -p /home/pkcs12/projects/opencode/packages/app/tsconfig.json` ✅
- `bunx eslint /home/pkcs12/projects/opencode/packages/app/src/context/global-sync.tsx /home/pkcs12/projects/opencode/packages/app/src/components/settings-providers.tsx /home/pkcs12/projects/opencode/packages/app/src/components/dialog-custom-provider.tsx /home/pkcs12/projects/opencode/packages/app/src/components/dialog-select-model.tsx` ✅
- `./webctl.sh dev-refresh` ✅
- `./webctl.sh status` ✅（development web runtime healthy）
- Architecture Sync: Verified (No doc changes)
  - 依據：本輪為 webapp sync state ownership 收斂，未改變 repo 的總體 architecture 分層與 runtime 邊界。

## 目前的核心結論

### A. 現況存在至少四種 state authority

1. component-local optimistic state
2. `globalSync.data.*` 全域 store
3. backend mutation 完成後的重新 bootstrap / refresh 結果
4. event bus 觸發的 reload / refresh

這四者目前缺乏統一的版本語意與 owner 邏輯，因此會出現：

- stale refresh 覆蓋新值
- bootstrap 導致局部 UI state 丟失
- component 被迫自行補 optimistic overlay
- 相同資源在不同頁面出現不一致寫法

### B. 高風險資源排序

1. `config.disabled_providers`
   - 同時被 settings/provider dialog/model selector 消費與修改
   - 小改動卻可能引發 global bootstrap

2. model preferences / visibility
   - local persisted user store + remote preferences API + debounced write
   - 易發生 late read / write-after-read 類問題

3. active account state
   - 與 account families、provider rows、model availability 強耦合
   - account 切換後會連動 model list 與 quota/cooldown 呈現

4. permission / custom provider config
   - 目前仍多處採 optimistic patch + global re-bootstrap

## Refactor 原則

### 1. 把 mutation layer 與 read layer 分離

- component 不直接拼湊：
  - optimistic patch
  - API 呼叫
  - rollback
  - refresh 收斂
- 改成由統一 resource action 負責，例如：
  - `configActions.setDisabledProviders(...)`
  - `modelPreferenceActions.setVisibility(...)`
  - `accountActions.setActive(...)`

### 2. bootstrap 只用於 init / recovery

- 正常 mutation success 後，不應預設做全域 bootstrap。
- 只在以下情境使用：
  - 首次載入
  - reconnect / server restart
  - 無法局部 patch 的 recovery path

### 3. 每種資源建立單一 client-side canonical store

- UI 一律讀 `effective resource state`
- optimistic overlay 由 resource store 統一維護
- component 不自己保管半套 overlay

### 4. 引入 request/revision guard

- 每個 mutation 帶 request id 或 revision token
- 較舊的 read result 不得覆蓋較新的 optimistic / committed state

### 5. 局部 patch 優先於全量 replace

- `disabled_providers` 更新只 patch config slice
- model preference 更新只 patch preference slice
- 避免「小 mutation → global dispose → full bootstrap」鏈條

## 建議的分階段落地

### Phase 1 — 收斂 config mutations（低風險，高報酬）

- 建立 `config resource action` 封裝：
  - optimistic overlay
  - request lifecycle
  - success reconcile
  - rollback
- 將以下呼叫端統一改接 action layer：
  - `settings-providers.tsx`
  - `dialog-select-model.tsx`
  - `dialog-custom-provider.tsx`
  - `settings-permissions.tsx`
- 目標：消滅 component 直接 `globalSync.set("config", ...) + updateConfig(...)` 的模式

### Phase 2 — 拆分 globalSync 的 reload 粒度

- 區分：
  - `refreshConfig()`
  - `refreshProviders()`
  - `refreshAccounts()`
  - `bootstrapGlobal()`
- `global.disposed` 不再一律全量 refresh；先依事件來源/資源類型做最小收斂

### Phase 2 實作進度（granular refresh）

#### 實作內容

- `packages/app/src/context/global-sync/bootstrap.ts`
  - 抽出 `refreshGlobalSlices(...)` 與 `GlobalRefreshSlice`，讓 global store 可只刷新 `config / provider / provider_auth / account_families / project` 的指定切片，而不是每次都走 full bootstrap。
- `packages/app/src/context/global-sync.tsx`
  - 新增 `inferConfigRefreshScope(...)`，根據 config patch 內容決定 refresh scope：
    - `disabled_providers` → `config + provider`
    - `permission` → `config`
    - `provider` → `config + provider + provider_auth`
    - 其他未知 patch → fallback full bootstrap
  - `updateConfig()` 對可辨識的小型 config mutation 不再預設 `bootstrap()`；改走 `refreshGlobal(scope)`。
  - 新增 `pendingGlobalDisposedScope` + 短期 TTL，讓本端已知 mutation 觸發的 `global.disposed` 可被 consume 成 partial refresh，而不是再次全量 refresh。
  - `setDisabledProviders()` 同步改走 partial refresh（`config + provider`）。
- `packages/app/src/context/global-sync/event-reducer.ts`
  - `applyGlobalEvent(...)` 新增 `onDisposed` hook，允許 main global sync 對已知的 `global.disposed` 事件做細粒度接管。
- `packages/app/src/context/global-sync/event-reducer.test.ts`
  - 新增測試，驗證 custom disposed handler 可成功攔截 `global.disposed` 並避免預設 full refresh。

#### 本階段收益

- 已知 config mutation 不再一律引發 `bootstrapGlobal()`。
- `global.disposed` 不再對本端已知的小 mutation 自動升級成 full refresh。
- `disabled_providers` / `permission` / `provider config` 已有初步 resource-scoped refresh 策略。

#### 本階段仍未完成

- backend `global.disposed` 事件本身尚未攜帶 resource metadata；目前仍需以前端 pending scope 來推斷。
- 若是外部來源或未知 mutation 觸發的 `global.disposed`，仍會 fallback 到 full refresh。
- directory-level refresh 與 global-level refresh 的依賴邊界仍偏粗，尚未拆到更細的 scheduler 層。

#### Phase 2 Validation

- `bunx tsc --noEmit -p /home/pkcs12/projects/opencode/packages/app/tsconfig.json` ✅
- `bunx eslint /home/pkcs12/projects/opencode/packages/app/src/context/global-sync.tsx /home/pkcs12/projects/opencode/packages/app/src/context/global-sync/bootstrap.ts /home/pkcs12/projects/opencode/packages/app/src/context/global-sync/event-reducer.ts /home/pkcs12/projects/opencode/packages/app/src/context/global-sync/event-reducer.test.ts` ✅
- `bun test /home/pkcs12/projects/opencode/packages/app/src/context/global-sync/event-reducer.test.ts` ✅
- `./webctl.sh dev-refresh` ✅
- `./webctl.sh status` ✅（development web runtime healthy）
- Architecture Sync: Verified (No doc changes)
  - 依據：Phase 2 仍屬 webapp global sync 的前端協調策略優化，未改變 repo architecture 全貌與 runtime 系統邊界。

### Phase 3 — 把 model preferences 改成正式 resource store

- 將 `context/models.tsx` 拆成：
  - canonical preference store
  - remote adapter
  - debounced writer with in-flight guard
- 明確定義 local persisted cache 與 server truth 的 reconcile 規則

### Phase 3 實作進度（model preference resource store）

#### 實作內容

- `packages/app/src/context/models.tsx`
  - 抽出純函式：
    - `normalizeUsers(...)`
    - `sameUsers(...)`
    - `buildUsersFromRemote(...)`
  - 將原本分散在 `createEffect`、remote read、local mutation 裡的偏好正規化邏輯，收斂成明確的 canonical user-preference transform。
  - 新增 `remoteSync.mutationVersion / readVersion / writeVersion`，讓 model preference sync 有基本版本語意。
  - local mutation 改走 `mutateUsers(...)`：
    - 先提升 `mutationVersion`
    - 再更新 canonical `store.user`
    - 避免 mutation 與 remote read/write 各自直接碰 state。
  - initial remote read 改成版本保護：
    - 讀取開始時記錄 `readVersion`
    - response 回來後，若期間已有新的 local mutation，則不覆蓋當前 local preference state
    - 解決 late remote read 把本地剛切換的 model visibility/favorite 蓋掉的問題
  - debounced remote write 改成 snapshot + `writeVersion`：
    - 排程當下複製 user snapshot 與 hiddenProviders
    - 寫入結果若已落後於較新的 write，不再對當前 canonical state 產生影響
- `packages/app/src/context/local.tsx`
  - 保持既有 API，不需調整呼叫端；Phase 3 將一致性責任留在 `models.tsx` 內部，不把改動擴散到 consumer。

#### 本階段收益

- model preferences 現在至少有單一 canonical client store：`store.user`
- local mutation 與 remote read/write 不再直接互相覆蓋
- 晚到的 initial remote read 不會再回頭覆蓋使用者剛做的本地偏好變更
- 為後續把 model preference adapter 進一步抽成獨立 module 打下基礎

#### 本階段仍未完成

- 目前 `models.tsx` 仍是單檔承載 canonical store + remote adapter；尚未拆成獨立 resource module
- remote write 失敗目前仍採 best-effort，不會主動顯示 retry 狀態或錯誤提示
- `hiddenProviders` 仍留在同一 remoteSync 物件內，尚未進一步收斂到更完整的 preference resource abstraction

#### Phase 3 Validation

- `bunx tsc --noEmit -p /home/pkcs12/projects/opencode/packages/app/tsconfig.json` ✅
- `bunx eslint /home/pkcs12/projects/opencode/packages/app/src/context/models.tsx /home/pkcs12/projects/opencode/packages/app/src/context/local.tsx` ✅
- Architecture Sync: Verified (No doc changes)
  - 依據：Phase 3 屬前端 state synchronization 改善，未改變 repo architecture 全貌或 backend/runtime 系統邊界。

### Phase 4 — account/provider/model selection state normalization

- 把 selected provider / selected account / effective model availability 的推導從 component 抽到 selector layer
- 目標是讓多個頁面共用同一套 derived selectors，而不是各自 memo 各自算

### Phase 4 實作進度（selector layer normalization）

#### 實作內容

- `packages/app/src/components/model-selector-state.ts`
  - 新增共用 selector/helper：
    - `familyOf(...)`
    - `isAccountLikeProviderId(...)`
    - `getActiveAccountForFamily(...)`
    - `getModelUnavailableReason(...)`
    - `pickSelectedProvider(...)`
    - `pickSelectedAccount(...)`
    - `getFilteredModelsForSelection(...)`
  - 讓 provider/account/model selection 的推導邏輯從單一 component 中抽出，形成可重用 selector layer。
- `packages/app/src/components/dialog-select-model.tsx`
  - provider 預設選取改用 `pickSelectedProvider(...)`
  - account 預設選取改用 `pickSelectedAccount(...)`
  - filtered models 推導改用 `getFilteredModelsForSelection(...)`
  - model unavailable / active account 推導改用共用 helper，而不再在 component 內各自維護推導規則

#### 本階段收益

- provider / account / model 三段 selection 的主要推導邏輯已脫離 `dialog-select-model.tsx` 的大型 component body
- 後續若 settings/admin/web 其他頁面要共用相同選取規則，可直接複用 selector layer
- 為將來把 selector layer 進一步升級為專用 resource selector module 降低成本

#### 本階段仍未完成

- account quota hints、dialog reopen state、部分 UI-only orchestration 仍留在 component 內
- 目前 selector layer 還是 function collection，尚未進一步模組化成更完整的 domain selector package
- 其他頁面尚未全面改用這批 selectors；本輪先收斂 model selector 主路徑

#### Phase 4 Validation

- `bunx tsc --noEmit -p /home/pkcs12/projects/opencode/packages/app/tsconfig.json` ✅
- `bunx eslint /home/pkcs12/projects/opencode/packages/app/src/components/model-selector-state.ts /home/pkcs12/projects/opencode/packages/app/src/components/dialog-select-model.tsx` ✅
- `./webctl.sh dev-refresh` ✅
- `./webctl.sh status` ✅（development web runtime healthy）
- Architecture Sync: Verified (No doc changes)
  - 依據：Phase 4 僅做前端 selector layer 抽離與共用規則正規化，未改變 repo architecture 全貌或 runtime 邊界。

## 建議的第一個實作切入點

若下一步要真正動手，建議先做：

**`config.disabled_providers` action layer 抽取**

原因：

- 已有真實 bug 證據
- 影響面夠廣，能驗證架構方向
- 風險低於直接重寫整個 global sync
- 做完後可作為 permission/custom-provider/config 其他 mutations 的模板

## 預期收益

- 消除 stale refresh 類 toggle 抖動問題
- 減少列表 scroll / selection / focus 被全局 reload 打掉
- 降低 component 自己維護 optimistic state 的重複成本
- 為 provider/model/account 三組高互動資源建立可重用同步模式
