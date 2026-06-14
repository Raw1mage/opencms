# Bug Report: webapp 模型管理員「提供者」列表未以顏色標示當前 active 提供者（桌面/手機皆有）

## 0. Handoff Summary

在 webapp 的「模型管理員」視窗中，最左欄「提供者」列出所有 provider 家族（claude-cli、gemini-cli、codex、copilot-cli、rawbase），但**沒有任何視覺標示哪一個 provider 是當下被啟用（active）的那一個**。使用者回報的截圖為**電腦（桌面）版**，但同一問題在手機版同樣存在，屬跨版型的共通呈現缺陷。使用者必須靠記憶或逐一點開才能判斷目前生效的提供者，這是一個 UX 缺陷。期望行為是用顏色（active state）把當前 active provider 與其他 provider 區分開來。

**元件已定位（confirmed）**：三欄式模型管理員就是 `packages/app/src/components/dialog-select-model.tsx`，最左 provider 欄渲染在 `dialog-select-model.tsx:1760-1791`，每個 provider 列由 `ProviderItem`（`dialog-select-model.tsx:623-664`）渲染。目前 provider 列只吃兩個視覺狀態：`selected`（你點開哪個 provider 來看它的帳號/模型，屬「面板導覽選取」）與 `enabled`（眼睛圖示顯示/隱藏）；**沒有任何 prop 標示「當前生效（active）的 provider」**。而「當前 active provider」其實已可算出 —— 元件內 `currentModel()` 與 line 1433 的 `currentProviderID = modelApi.current(params.id)?.provider?.id` 就是它。修法：把 active 旗標算出後傳進 `ProviderItem`，以色彩 token 標示，並與 `selected`/`enabled` 兩維度保持正交。

## 1. Bug Identity

| Field                         | Value                                                                 |
| ----------------------------- | --------------------------------------------------------------------- |
| Title                         | 模型管理員「提供者」列表未以顏色標示 active provider                   |
| Component                     | webapp — 模型管理員（Model Manager）三欄式視窗，最左「提供者」欄（桌面/手機共通） |
| Reporter                      | 使用者回報（桌面版截圖）／本 session                                  |
| Date                          | 2026-06-11                                                            |
| Severity                      | low（純可用性，無功能/資料風險）                                      |
| Priority                      | P3（體驗改善，非阻斷）                                                 |
| Status                        | confirmed（元件與根因已定位，待修復）                                 |
| Affected versions/tools/paths | `packages/app/src/components/dialog-select-model.tsx`（provider 欄 1760-1791；`ProviderItem` 623-664）；桌面與手機版皆受影響 |

## 2. Environment

- Repo path：`/home/pkcs12/projects/opencode`
- 平台：webapp，桌面與手機版皆有此問題（使用者截圖為桌面版）
- 觸發畫面：「模型管理員」彈窗（標題「模型管理員」；右上有「提交」「+ 模型提供者」「管理模型」；左上有「精選／全部」切換）
- 三欄結構：
  - 左欄「提供者」：claude-cli (1)、gemini-cli (2)、codex (6)、copilot-cli (1)、rawbase (1)，各帶眼睛（顯示/隱藏）圖示
  - 中欄「帳號」：多個帳號 + 5H/WK 配額用量（如 `5H:99% WK:0%`），其中一個帳號帶 ✓ 表示選中
  - 右欄「模型管理員」：列出模型（如 GPT-5.5），帶眼睛圖示與 ✓
- 候選前端來源：`packages/app/src/`（standard opencode UI）— 但截圖的三欄/配額條樣式與既有 dialog 不完全吻合，可能為另一個 admin webapp，**需先確認**。

## 3. Expected Behavior

- 「提供者」欄中，**當前 active（生效中）的 provider 必須以顏色與其他 provider 明顯區分**（例如 active 用 accent/highlight 前景或背景色，非 active 維持中性色）。
- 視覺對比需在桌面與手機兩種版型/尺寸下皆清晰可辨，且符合既有 design token（不可硬編色碼）。
- 切換 active provider 後，顏色標示應即時跟著移動到新的 active provider。
- 必須維持：不破壞既有的眼睛圖示（顯示/隱藏）與帳號選中（✓）的語意，active-provider 標示與這些狀態為**正交**的視覺維度。

## 4. Actual Behavior

- 「提供者」欄中所有 provider 文字皆為相同樣式（同一前景色），無任何顏色或高亮差異。
- 從截圖無法看出哪一個 provider 為當前 active。
- 中欄帳號有 ✓ 標示選中、右欄模型有 ✓，唯獨左欄 provider 缺少對應的 active 視覺標示。

（截圖為使用者於對話中貼上之畫面，描述如 §2；尚未存檔為附件。）

## 5. Steps To Reproduce

`Suggested reproduction`（元件未確認，步驟為近似）：

1. 於瀏覽器開啟 webapp（桌面或手機版皆可重現）。
   - 預期：進入主介面。
2. 開啟「模型管理員」視窗（截圖中的彈窗）。
   - 預期：看到三欄「提供者／帳號／模型管理員」。
3. 觀察左欄「提供者」列表。
   - 預期（修正後）：active provider 以顏色突出。
   - 實際：所有 provider 樣式一致，無法辨識 active。

## 6. Evidence

| Evidence | Type      | Reference                                                          | What it shows                                         |
| -------- | --------- | ----------------------------------------------------------------- | ----------------------------------------------------- |
| E1       | 截圖      | 使用者對話內貼圖（桌面版模型管理員視窗）                          | 左欄 provider 全部同色，無 active 標示                |
| E2       | file      | `packages/app/src/components/dialog-select-model.tsx:1760-1791`   | provider 欄渲染：`<For each={providersForMode()}>` 內每列 `ProviderItem` 只傳 `selected`（導覽選取）與 `enabled`（眼睛），無 active 旗標 |
| E3       | file      | `packages/app/src/components/dialog-select-model.tsx:623-664`     | `ProviderItem` 樣式：`selected` → `bg-surface-raised-pressed text-text-strong`；否則中性色。無 active 分支 |
| E4       | file      | `packages/app/src/components/dialog-select-model.tsx:1433`        | active provider 來源已存在：`currentProviderID = modelApi.current(params.id)?.provider?.id`（亦見 `currentModel()` @1154） |
| E5       | file      | `packages/app/src/components/model-selector-state.ts:175-243`     | `buildProviderRows` 產出的 `ProviderRow = {id, providerKey, name, accounts, enabled}` —— 型別本身無 active/current 欄位 |
| E6       | i18n      | `packages/app/src/i18n/zht.ts`（`dialog.model.manage`、`common.providers`、`settings.accounts.title`） | 對應截圖三欄標題字串，反查確認即此元件 |

## 7. Impact / Risk

- 使用者可見影響：無法一眼辨識當前生效的 provider，需額外點擊或記憶，增加操作成本。
- 資料遺失／損毀風險：無。
- 可靠性風險：無（純呈現）。
- 安全風險：無。
- 工作流影響：低；多 provider／多帳號使用者影響較明顯。
- Blast radius：僅限模型管理員視窗的 provider 欄呈現層。

## 8. Root-Cause Hypotheses

### H1：渲染元件未持有「active provider」狀態或未綁定樣式 — ✅ 已確認（CONFIRMED）

Confidence: high

確認依據（E2/E3/E5）：

- provider 欄（`dialog-select-model.tsx:1771-1788`）每列只傳 `selected`（=`selectedProviderId() === provider.id`，面板導覽）與 `enabled`（眼睛）；無 active 旗標。
- `ProviderItem`（`623-664`）的 class 只有 `selected` / 非 selected 兩條分支，沒有 active 視覺分支。
- `buildProviderRows` 產出的 `ProviderRow` 型別（`model-selector-state.ts:175-243`）根本沒有 active/current 欄位。
- 對照：active provider 其實「算得出來」（`currentProviderID` @1433 / `currentModel()` @1154），只是沒被用到 provider 欄的呈現。

→ H1 成立：active 維度從未被接進 provider 欄的視覺層。

### H2：有 active 樣式但顏色對比不足 — ❌ 已推翻（REFUTED）

Confidence: —

- `ProviderItem` 完全沒有 active 分支（E3），不存在「已套淡色但對比不足」的情況。非對比問題，是缺欄位。

### H3：截圖元件非 `packages/app`，而是獨立 admin webapp — ❌ 已推翻（REFUTED）

Confidence: —

- 以 i18n key 反查（E6）+ 三欄版面比對，確認就是 `packages/app/src/components/dialog-select-model.tsx`（`DialogSelectModel`），由 `dialog-manage-models` 旁的同檔渲染。`提交`/`+ 模型提供者`/`管理模型`、`5H/WK` 配額條皆在此元件內。非獨立 webapp。

## 9. Workarounds

- 暫時透過中欄被選中（✓）的帳號所屬家族，間接推斷 active provider。
  - 何時用：修正前。
  - 缺點：仍需多看一步，且帳號選中 ≠ provider active 的語意未必等價。
  - 何時不用：一旦顏色標示上線即不需要。

## 10. Proposed Fix Direction

根因已確認，修法明確：

1. 算出 active provider id：在 `dialog-select-model.tsx` 用既有的 `currentModel()`（@1154）/`currentProviderID`（@1433）取得目前生效模型的 `provider.id`，再以 `normalizeProviderKey(...)` 正規化成與 `ProviderRow.providerKey` 同一格式（provider 列是以家族 key 如 `claude-cli` 分組，currentModel 的 `provider.id` 可能是細分 id，務必正規化後再比對，否則永遠不相等）。
2. 傳旗標：在 provider 欄的 `<For>`（`1771-1788`）為每列計算 `active = normalizeProviderKey(provider.id) === normalizeProviderKey(currentProviderKey)`，當作新 prop 傳進 `ProviderItem`。
3. 加樣式：在 `ProviderItem`（`623-664`）新增 active 視覺分支，用既有 design token 的 accent/強調色（前景色或左側 indicator/圓點），**不硬編色碼**。
4. 維持正交：active 與 `selected`（導覽選取的 `bg-surface-raised-pressed`）、`enabled`（眼睛）為三個獨立維度；active 與 selected 可能同時成立（你正看著的就是 active 的那個），樣式需可疊加而不互相蓋掉。
5. 相容性：純前端呈現增量，不改 `ProviderRow` 以外資料模型；若選擇把 active 算進 `buildProviderRows`，需同步更新 `model-selector-state.ts` 型別與其 test。確認桌面與手機暗色主題下對比皆足夠（WCAG 可作參考）。

> 注意：provider id 正規化是這題唯一的隱藏陷阱 —— 不做正規化會導致 active 永遠標不到。

## 11. Acceptance Criteria

- Positive：當有 active provider 時，「提供者」欄中該項以顏色明顯區別於其他項。
- Negative：非 active 的 provider 不得套用 active 顏色。
- 切換：變更 active provider 後，顏色標示即時移動到新 active 項。
- 正交性：眼睛圖示（顯示/隱藏）與帳號 ✓ 行為不受影響。
- 跨版型可辨識：桌面與手機實際主題下 active 與非 active 對比皆清晰。
- 不硬編色碼：使用既有 design token。

## 12. Open Questions

- 「active」定義以「目前對話/session 生效的 model 之 provider」為準（`modelApi.current(params.id)`）。需確認這與使用者直覺的「active provider」一致；中欄帳號 ✓ 是該 provider 內的 active 帳號，與 provider-level active 為不同層級，勿混用。
- 視覺呈現選哪種：accent 前景色、左側 indicator bar、或圓點？（需設計/使用者偏好；建議至少前景色 + 一個非顏色輔助標示以兼顧色弱無障礙。）
- 是否需要在 selected≠active 時兩者並存的視覺仍清楚可辨（例如你點開 A 看，但 active 是 B）。

## 13. Next Session Checklist

1. 第一個檔案：開 `packages/app/src/components/dialog-select-model.tsx`，定位 provider 欄 `<For each={providersForMode()}>`（`1771-1788`）與 `ProviderItem`（`623-664`）。
2. 第一步：在該 `<For>` 內以 `currentModel()`/`currentProviderID`（@1154/@1433）算出 active provider key，**先做 `normalizeProviderKey` 正規化**再與 `provider.id` 比對。
3. 要回憶的證據：本 BR §6 的 E2–E6（精確行號）。
4. 程式修改區：`ProviderItem` 新增 `active` prop 與 token-based active 樣式分支；必要時同步 `model-selector-state.ts:175-243` 的 `ProviderRow` 型別與其 test。
5. 嘗試重現：依 §5 開啟模型管理員，確認修正前 provider 欄無 active 顏色、修正後 active provider 明顯著色且切換即時跟隨。
6. 預期停點：active 著色上線、與 selected/enabled 正交、桌面+手機對比足夠、最小測試通過即可收尾並依 §closing 流程關閉。

---

## Resolution (2026-06-11, hotfix)

### Resolution Status

- **Fixed / resolved**，本 session 直接 hotfix。
- Repo/worktree：`/home/pkcs12/projects/opencode`（branch `main`，working tree）。

### Final RCA

- 確認根因：模型管理員 provider 欄從未把「session 當前生效的 provider」接進視覺層。`ProviderItem` 只有 `selected`（面板導覽）與 `enabled`（眼睛）兩個視覺維度。
- 假設驗證：**H1 確認**（缺 active 旗標/樣式）；**H2 推翻**（不是顏色對比不足，是根本沒有 active 分支）；**H3 推翻**（就是 `packages/app` 的 `dialog-select-model.tsx`，非獨立 admin webapp）。
- 隱藏陷阱（§10 預警）成立並已處理：provider 列以家族 key（如 `claude-cli`）分組，而 `currentModel().provider.id` 可能是細分 id，必須 `providerKeyOf()` 正規化後再比對，否則 active 永遠標不到。

### Fix Implemented

- 變更檔案：`packages/app/src/components/dialog-select-model.tsx`（單檔）。
  1. 新增 `activeProviderKey` memo = `providerKeyOf(currentModel()?.provider?.id)`，正規化成與 `ProviderRow.id` 同格式。
  2. `ProviderItem` 新增 `active?: boolean` prop 與 active 視覺分支：左側 accent bar + accent 前景色（`border-icon-brand-base` / `text-icon-brand-base`）＋一個非顏色輔助圓點（`bg-icon-brand-base`，`aria-hidden`），兼顧色弱無障礙。
  3. provider 欄 `<For>` 傳入 `active={activeProviderKey() === provider.id}`。
- 行為改變：模型管理員左欄 provider 列表中，當前生效的 provider 以品牌色 + 左側 indicator + 圓點明顯標示；與 `selected`（導覽選取）、`enabled`（眼睛）三維度正交，可疊加。桌面/手機共用同一元件，兩版型同時修正。
- 相容性：純前端呈現增量，未改 `ProviderRow` 型別與任何資料模型；用既有 design token，無硬編色碼。

### Verification Results

- Typecheck：`bun run --cwd packages/app typecheck` → 乾淨無錯。
- 單元測試：`model-selector-state.test.ts` 24 pass / 0 fail。
  - 註：同批跑到的 `dialog-connect-provider.test.ts` 有 1 個 Kobalte「client-only API on server」失敗，**為既有環境問題**，該測試未 import 本次變更檔案，與此修正無關。
- Build：`bun run build`（vite）成功；驗證 `border-icon-brand-base`/`text-icon-brand-base` 已進 `dist/assets/dialog-select-model-*.js`，`icon-brand-base` 色彩存在於編譯後 CSS（token 解析成功、未被 purge），active 比對邏輯已 ship。
- 未驗證/留待：未在實機瀏覽器目視截圖確認（桌面+手機暗色主題對比）；需 gateway 重啟後由使用者目視。

### Follow-ups / Residual Risk

- **需重啟 gateway 才會生效**：dist 已重建，但 live runtime 需經合法路徑重啟（`system-manager:restart_self` 或 `webctl.sh restart`）—— 依規範我不自行重啟，請使用者觸發。
- 殘餘風險低：純樣式增量。唯一需目視確認的是品牌色在各主題下與 `selected` 背景疊加時對比足夠（已用非顏色圓點兜底，色弱情境亦可辨識）。
- 無需後續程式變更；若日後 `ProviderRow` 想內建 active 欄位再重構即可（非必要）。
