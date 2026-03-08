# Event: Model Selector Account Usage Suffix

Date: 2026-03-08
Status: In Progress

## 1. 需求

- 在 web model selector 浮窗的 account 欄位中，除了帳號名稱，也顯示帳號用量資訊。
- 用量格式改為優先對齊 TUI admin panel 的顯示規則，而不是單獨沿用 web prompt footer 文案。
- 代表性格式例如 OpenAI 使用 TUI admin 樣式：`yeatsluo@gmail.com 5H:80% WK:27%`。
- 不影響非 OpenAI provider 的既有帳號顯示。
- 後續擴充：讓 web prompt footer 也走共享 quota formatter，並把 Gemini / Google-API 的 request-counter 顯示規則一起抽成共用層。
- account 欄位的視覺呈現需再優化為近似雙欄對齊：左側帳號、右側 usage，無額外格線。
- model selector 三欄分隔線需支援拖曳調整欄寬，並將結果保存在 local 端；需設定安全上下限與 reset 能力。

## 2. 範圍

### IN

- `packages/app/src/components/dialog-select-model.tsx`
- `packages/app/src/components/prompt-input.tsx`
- `packages/app/src/components/prompt-input/quota-refresh.ts`
- `packages/opencode/src/account/quota/display.ts`
- `packages/opencode/src/account/quota/index.ts`
- `packages/opencode/src/server/routes/account.ts`
- `packages/opencode/src/cli/cmd/tui/component/dialog-admin.tsx`
- 必要時同步 `docs/ARCHITECTURE.md`

### OUT

- 不重做 model selector 版面結構
- 不變更 OpenAI quota 後端資料來源
- 不新增高頻全域 polling

## 3. 任務清單

- [x] 讀取 architecture 與 model selector / prompt footer / quota route 相關程式碼
- [x] 建立 account row quota 顯示資料流
- [x] 在 model selector account 欄位渲染 quota suffix
- [x] 執行 targeted validation
- [x] 檢查 Architecture Sync 是否需要更新

## 4. Debug Checkpoints

### Baseline

- 症狀：`packages/app/src/components/dialog-select-model.tsx` 的 account 欄位目前只顯示 `row.label`，沒有 provider-specific quota suffix。
- 既有參考：`packages/app/src/components/prompt-input.tsx` 已透過 `/api/v2/account/quota` 顯示 OpenAI footer hint。
- 缺口 1：`packages/opencode/src/server/routes/account.ts` 的 `/quota` 原本只回 active account；model selector 需要查詢列表中指定 account。
- 缺口 2：web model selector 原先使用 footer 風格 `(5hrs:.. | week:..)`，與 TUI admin panel 的 `5H:.. WK:..` 規則分叉。
- RCA 補充：在 web authenticated user + user daemon 路徑下，account 列表來自 daemon `/account`，但 `/account/quota` 仍直接讀主 server process 的 `Account.listAll()`；兩邊帳號來源不一致時，quota route 可能找不到對應 account，導致 hint 消失。

### Execution

- `packages/opencode/src/server/routes/account.ts` 的 `/quota` query 新增可選 `accountId`，若指定帳號存在於該 family，直接回傳該帳號的 quota hint；否則維持 active account fallback。
- 新增共享 formatter：`packages/opencode/src/account/quota/display.ts`，集中處理 OpenAI quota 的 `admin` / `footer` 兩種格式。
- 共享 formatter 再擴充 Gemini / Google-API 的 request monitor 顯示規則，避免 TUI admin 與 web route 各自維護 `${pct}% (${used}/${limit})` 字串。
- `packages/opencode/src/cli/cmd/tui/component/dialog-admin.tsx` 的 OpenAI admin quota 顯示改為使用共享 formatter，避免 TUI / Web 各自維護字串格式。
- `packages/opencode/src/cli/cmd/tui/component/dialog-admin.tsx` 的 Gemini / Google-API usage 也改為使用共享 formatter。
- `packages/app/src/components/dialog-select-model.tsx` 新增 `accountQuotaHints` resource，改為使用 `/api/v2/account/quota?...&format=admin` 對齊 TUI admin panel 樣式。
- model selector account 列表改為顯示 `row.label + hint`，因此 OpenAI 帳號會呈現 `name 5H:.. WK:..`；其他 provider 目前仍維持既有 placeholder / 無顯示策略。
- quota 請求沿用既有 `/api/v2/account/quota` 路徑與快取邏輯，未引入新的背景 polling。
- `packages/opencode/src/server/routes/account.ts` 的 `/quota` 進一步支援 `format=admin|footer` 與 Gemini / Google-API request monitor hint，讓 web prompt footer / model selector 都可共用同一路徑。
- `packages/app/src/components/prompt-input.tsx` 改為對所有支援 quota 的 provider family 走共享 `/api/v2/account/quota?...&format=footer` 路徑，不再只對 OpenAI 啟用。
- `packages/app/src/components/prompt-input/quota-refresh.ts` 的 refresh gate 改為 generic provider quota gate（目前含 `openai` / `google-api` / `gemini-cli`）。
- `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx` 的 OpenAI footer 也改用共享 formatter，避免 TUI prompt/footer 與 web footer 再次分叉。
- `packages/app/src/components/dialog-select-model.tsx` 的 account row 改為視覺雙欄：帳號名稱保持左側 truncate，usage 以右側弱化 tabular 數字呈現，讓多列更容易掃讀。
- account row 再進一步微調：usage 欄位給固定寬度並右對齊，active row 的 usage 稍微提亮，讓掃讀與目前選中態都更穩定。
- RCA 修正：`packages/opencode/src/server/routes/account.ts` 的 `/quota` 在 web user daemon 模式下，改為先透過 `UserDaemonManager.callAccountQuota()` 轉發到 daemon 端，確保 account list 與 quota lookup 使用同一份 per-user account state。
- `packages/opencode/src/server/user-daemon/manager.ts` 新增 `callAccountQuota()`，供 `/account/quota` 走 daemon proxy。
- RCA 補強：用 in-process `Server.App().fetch()` 驗證後，`/api/v2/account/quota` 對 OpenAI 帳號可正常回傳 `hint`；因此第二層問題落在 web 端 resource/fetch 生命週期，而非 formatter 本身。
- `packages/app/src/components/dialog-select-model.tsx` 的 quota resource 現在會等待 web auth ready，並改成 `Promise.allSettled()`；避免任一 quota request throw 導致整個 account usage map 直接空掉。
- `packages/app/src/components/prompt-input.tsx` 的 quota resource 同步加入 web auth gate 與 fetch error fallback，避免 reload 後首次未授權 / 短暫失敗造成 quota hint 永久空白。
- 使用者回報上述 RCA 修正後仍未恢復顯示，因此回退到「最後一個已知可顯示數值」的實作：model selector 回到單行 `name + hint` 呈現，移除本輪 RCA 引入的 web auth gating / daemon quota proxy，避免把純顯示調整擴大成資料流重構。
- 依使用者最新指示，本輪僅處理 account 欄對齊效果：不再碰 quota 資料流，只在 `packages/app/src/components/dialog-select-model.tsx` 內把 row 視覺拆成「左側帳號 / 右側固定寬度 usage」的雙欄排版。
- 追蹤補充：使用者回報初次開啟時 usage 不顯示，但切換 account 後才出現；因此在同一檔案內補上 selector quota 的 60 秒前端快取，並在 provider/account rows ready 時主動 `refetch()` 一次，避免首次開啟依賴後續互動才刷新。同時把 active 勾勾移到 usage 之前，並保留固定寬度佔位以穩定對齊。
- 使用者另回報 active account 被點選後會跳到列表第一列；根因是 `buildAccountRows()` 會把 `active` 排到最前。已改為僅按 `label` 穩定排序，避免切換 active 時列表項目位移。
- 最新快取策略調整：selector 端快取不再因 TTL 過期而先清空顯示；只要有舊值就先顯示，當畫面再次有顯示需求且快取過期時，再針對 stale rows 動態更新。這樣可同時滿足「長時間保留可顯示值」與「有新顯示要求時才刷新」。
- 由於使用者回報最新版本仍未顯示 quota，本輪依使用者要求先加瀏覽器 console debug，只針對 `dialog-select-model.tsx` 的 selector quota effect / fetch / state merge 打點，不再擴大修改範圍。
- 根因確認：console 顯示 quota fetch / merge 都成功，但 UI 未更新；原因是 `<For>` row render 內先把 `const display = accountRowDisplay(row)` 存成非 reactive 區域變數，導致 quota signal 更新後 row 不會重算。已改為在 JSX 內直接讀取 `accountRowDisplay(row).quota`，讓 quota 顯示跟著 signal 更新。
- 後續整理：移除暫時 console debug，並將 TUI / webapp quota usage update/cache framework 收斂成兩層共享：
  - core 層：`packages/opencode/src/account/quota/hint.ts` + `getOpenAIQuotaForDisplay()`，統一 provider-specific hint 生成與 OpenAI stale-while-refresh。
  - web 層：`packages/app/src/utils/quota-hint-cache.ts`，統一 prompt footer / model selector 的前端 60 秒 hint cache 與 stale-on-demand refresh。
- TUI layout refinement：`dialog-admin.tsx` 的 Model Activities 列表改為 capped column widths（provider/model/account）+ 固定雙空格分隔，避免長模型名把中間欄位撐出大面積空白。
- 更正需求解讀：使用者要收的是整個 admin panel 浮窗的右緣外圍 padding / 寬度，而非 Activities rows 的 account 欄本身。已回退 account 欄 `21 -> 24`，改為透過 dialog width 收斂（`MIN_DIALOG_WIDTH 88 -> 85`，activities dynamic width buffer `+12 -> +9`）來縮窄右邊外圍留白。
- 新增 model selector 欄寬調整：web 三欄 grid 改為可拖曳 divider，provider/account 欄以 ratio 存進既有 `MODEL_MANAGER_LAYOUT_STORAGE_KEY`；desktop 模式下會對 provider/account/model 三欄套用最小寬度 clamp，並支援雙擊 divider reset 預設比例。
- 三欄標題格式再統一：provider/account/model 三欄都改成採用第一欄樣式的簡潔標題列（無額外分隔線、副標題只保留 mobile breadcrumb），避免三欄 header 規則各自為政。

### Validation

- `bunx tsc --noEmit -p packages/app/tsconfig.json` ✅
- `bunx tsc --noEmit -p packages/opencode/tsconfig.json` ✅
- `bunx eslint packages/app/src/components/dialog-select-model.tsx packages/opencode/src/server/routes/account.ts packages/opencode/src/account/quota/display.ts packages/opencode/src/account/quota/index.ts packages/opencode/src/cli/cmd/tui/component/dialog-admin.tsx` ✅
- `bunx eslint packages/app/src/components/dialog-select-model.tsx packages/app/src/components/prompt-input.tsx packages/app/src/components/prompt-input/quota-refresh.ts packages/opencode/src/server/routes/account.ts packages/opencode/src/account/quota/display.ts packages/opencode/src/account/quota/index.ts packages/opencode/src/cli/cmd/tui/component/dialog-admin.tsx packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx` ✅
- `bunx eslint packages/app/src/components/dialog-select-model.tsx` ✅ (layout refinement)
- `bunx eslint packages/app/src/components/dialog-select-model.tsx` ✅ (fixed-width usage column + active emphasis)
- `bunx eslint packages/app/src/components/dialog-select-model.tsx packages/app/src/components/prompt-input.tsx` ✅ (quota resource auth/fetch hardening)
- `bunx tsc --noEmit -p packages/app/tsconfig.json` ✅ (rollback)
- `bunx tsc --noEmit -p packages/opencode/tsconfig.json` ✅ (rollback)
- `bunx eslint packages/app/src/components/dialog-select-model.tsx packages/app/src/components/prompt-input.tsx packages/opencode/src/server/routes/account.ts packages/opencode/src/server/user-daemon/manager.ts` ✅ (rollback)
- `bunx tsc --noEmit -p packages/app/tsconfig.json` ✅ (shared web quota cache)
- `bunx tsc --noEmit -p packages/opencode/tsconfig.json` ✅ (shared core quota hint framework)
- `bunx eslint packages/app/src/components/dialog-select-model.tsx packages/app/src/components/prompt-input.tsx packages/app/src/utils/quota-hint-cache.ts packages/app/src/components/model-selector-state.ts packages/opencode/src/account/quota/openai.ts packages/opencode/src/account/quota/hint.ts packages/opencode/src/account/quota/index.ts packages/opencode/src/server/routes/account.ts packages/opencode/src/cli/cmd/tui/component/dialog-admin.tsx packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx` ✅
- Architecture Sync: Verified (No doc changes)
  - 比對依據：本次僅把 quota hint/update/cache 流程收斂到既有 account/quota 與 web UI 層，未新增新的架構邊界、服務拓樸或 runtime contract。
