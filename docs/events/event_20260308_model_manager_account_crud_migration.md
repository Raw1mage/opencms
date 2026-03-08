# Event: Migrate Web Account CRUD into Model Manager

Date: 2026-03-08
Status: In Progress

## 1. 需求

- web 設定視窗中的「帳號」頁面也要廢除。
- 新的帳號 CRUD 功能改放進「模型管理員」界面。
- 目標是直接對齊 TUI 的多帳號管理機制，而不是沿用 origin/dev 的 legacy settings accounts 頁。

## 2. 範圍

### IN

- `packages/app/src/components/dialog-settings.tsx`
- `packages/app/src/components/dialog-select-model.tsx`
- 可能新增/重用 account CRUD dialog 元件
- 必要時同步 `docs/ARCHITECTURE.md`

### OUT

- 不修改 TUI account CRUD 行為本身
- 不重做 provider / model selector 的主要資訊架構
- 不在本輪處理 origin/dev 舊 provider settings 整合

## 3. 任務清單

- [x] 盤點 web settings accounts 與 model manager 現況
- [x] 定義要對齊的 web account CRUD scope
- [x] 從 web settings 移除 accounts tab
- [x] 在 model manager 補上 account CRUD 入口與流程
- [x] 執行 targeted validation
- [x] 檢查 Architecture Sync 是否需要更新

## 4. Debug Checkpoints

### Baseline

- `packages/app/src/components/dialog-settings.tsx` 目前 server 區塊只剩 `accounts` tab，可直接收掉整個 legacy accounts 頁入口。
- `packages/app/src/components/settings-accounts.tsx` 目前只支援 list / set active，不具備完整 CRUD，也與新的模型管理員互動流不一致。
- `packages/app/src/components/dialog-select-model.tsx` 已有 provider/account/model 三欄、多帳號切換、quota 顯示、欄寬拖曳，是新的管理入口候選。

### Execution

- `packages/app/src/components/dialog-settings.tsx` 移除 legacy `accounts` tab，settings 視窗回到 desktop-only `general / shortcuts`。
- `packages/app/src/components/status-popover.tsx` 的 accounts 摘要卡片之「Manage」按鈕改導向 `DialogSelectModel`，避免再跳進已移除的 settings accounts 頁。
- `packages/app/src/components/dialog-select-model.tsx` 第二欄新增 account 管理模式：header 補上 `Add` / `Manage`，管理模式下每列顯示 `View / Edit / Delete` 動作，保留 row click 直接 `set active`。
- `packages/app/src/components/dialog-select-model.tsx` 新增 account details / rename / delete confirm dialogs；delete confirm 會顯示 `family / account name / account id`。
- `packages/opencode/src/server/routes/account.ts` 新增 `PATCH /account/:family/:accountId`，目前提供 web rename account name 能力。
- `packages/opencode/src/server/user-daemon/manager.ts` 新增 `callAccountUpdate()`，讓 per-user daemon mutation path 也支援 account rename。
- RCA：model manager persisted 欄寬初次開啟不正確套用的根因是 grid width 只在 `columnsEl` 尚未 ready 時以 dialog width 推算，實際 `columnsEl` mount 後沒有 reactive width source 觸發重新 clamp/template 計算。
- 修正方式：在 `dialog-select-model.tsx` 以 `ResizeObserver` 追蹤 `columnsEl` 真實寬度，並把載入 persisted layout 的 effect 改成單次 hydrate；因此 dialog 首次開啟就會用真實 grid width 套用 persisted ratios，而不是等使用者碰 divider 才更新。
- 互動微調：model manager 開出的 `view / edit / delete / add` 子浮窗改為在 close 後自動回到上一層 `DialogSelectModel`，保留當前 provider/account/management mode，而不是直接掉回主對話頁。
- 顯示微調：account management mode 內將 `View / Edit / Delete` 由文字按鈕改為 icon buttons，並在管理模式下隱藏 quota/useage 欄，避免帳號名稱被擠壓截斷。

### Validation

- `bunx tsc --noEmit -p packages/app/tsconfig.json` ✅
- `bunx tsc --noEmit -p packages/opencode/tsconfig.json` ✅
- `bunx eslint packages/app/src/components/dialog-select-model.tsx packages/app/src/components/dialog-settings.tsx packages/app/src/components/status-popover.tsx packages/opencode/src/server/routes/account.ts packages/opencode/src/server/user-daemon/manager.ts` ✅
- Architecture Sync: Updated
  - 比對依據：web admin capability boundary 已從「account visibility / activation」提升為 model manager 內的 account CRUD（新增、檢視、編輯名稱、刪除、設為 active），需同步更新 `docs/ARCHITECTURE.md`。
