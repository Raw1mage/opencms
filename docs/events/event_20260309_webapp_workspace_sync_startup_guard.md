# Event: Webapp workspace sync startup guard

Date: 2026-03-09
Status: Done

## 需求

- 修復 webapp 進入新 workspace 系統後的 startup crash：`Cannot read properties of undefined (reading '0')`。
- 讓 Sync context 在 child store 尚未穩定時，不會因直接讀 `current()[0]` 而整個 app 掛掉。

## 範圍

### IN

- `/home/pkcs12/projects/opencode/packages/app/src/context/sync.tsx`

### OUT

- 不改 workspace domain contract
- 不改 API shape

## 任務清單

- [x] 定位 startup crash 來源
- [x] 補 sync context guard/fallback
- [x] 驗證 webapp 不再因 `reading '0'` 崩潰

## Debug Checkpoints

### Baseline

- 使用者回報 webapp startup 失敗。
- 前端錯誤為：`TypeError: Cannot read properties of undefined (reading '0')`
- 目前 app `Sync` context 多處直接存取 `current()[0]`，若 child tuple 尚未穩定可用，會直接 crash。

### Execution

- 盤點後確認 `packages/app/src/context/sync.tsx` 內有多處直接讀取 `current()[0] / current()[1]`。
- 在新 workspace 系統進入 startup/bootstrap 邊界時，若 child tuple 尚未穩定可用，這些直接索引會導致前端直接拋 `reading '0'`。
- 修正方式：
  - 建立 `fallbackChild`
  - 將 `current()` 的直接 tuple 存取統一收斂為 `currentChild()/currentStore()/currentSetter()` helper
  - 讓 `data/status/ready/project/history.more/...` 都不再直接依賴裸的 `current()[0]`

### Validation

- `bun run --cwd packages/app typecheck` ✅
- `bun run --cwd packages/app test:unit -- src/context/global-sync/bootstrap.test.ts src/context/global-sync/child-store.test.ts src/context/global-sync/event-reducer.test.ts` ✅
- `bun run build --single` ✅
- `./webctl.sh dev-refresh` ✅
- `./webctl.sh status` ✅ (`https://crm.sob.com.tw` healthy, frontend 指向 `/home/pkcs12/projects/opencode/packages/app/dist`)
- Playwright headless smoke check (`https://crm.sob.com.tw`) ✅
  - `TITLE: OpenCode`
  - 無 `pageerror`
  - 無 console error
- Architecture Sync: Verified (No doc changes)
  - 本次是 app startup guard/fallback 強化，未改變 architecture boundary。
