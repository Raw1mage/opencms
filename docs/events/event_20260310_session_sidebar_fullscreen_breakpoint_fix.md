# Event: session sidebar fullscreen breakpoint fix

Date: 2026-03-10
Status: Done

## 需求

- 修正 PC 版 web session sidebar 在寬度小於 1024px 時誤切成全螢幕模式的問題。
- 僅在視窗寬度小於 450px 時，才讓 session sidebar / tool surface 走全頁模式。

## 範圍 (IN / OUT)

### IN

- `/home/pkcs12/projects/opencode/packages/app/src/pages/session.tsx`
- `/home/pkcs12/projects/opencode/packages/app/src/components/session/session-header.tsx`
- `/home/pkcs12/projects/opencode/docs/events/event_20260310_session_sidebar_fullscreen_breakpoint_fix.md`

### OUT

- 不重做 session shell pane topology
- 不改動全域 layout sidebar drawer 判斷
- 不處理與本次 breakpoint 無關的其他 session RWD 細節

## 任務清單

- [x] 確認 session sidebar 全頁模式的 breakpoint 來源
- [x] 將 session page / header 的 mobile tool 模式門檻改為 450px
- [x] 驗證 typecheck
- [x] 記錄 Architecture Sync 判定

## Debug Checkpoints

### Baseline

- `packages/app/src/pages/session.tsx` 以 `createMediaQuery("(min-width: 1024px)")` 決定 session page 是否走 desktop sidebar 邏輯。
- `packages/app/src/components/session/session-header.tsx` 也以同一個 1024px 門檻切換 desktop tool buttons 與 mobile full-page tool navigation。
- 結果是 PC 視窗只要小於 1024px，就會誤走 mobile/full-page tool 模式。

### Execution

- 將 session page 的 sidebar/full-page 切換門檻由 `1024px` 下修為 `450px`，讓 450px 以上仍維持 sidebar 模式。
- 同步將 session header 的 tool navigation breakpoint 改為 `450px`，避免 header 與 page shell 對同一個 session tool surface 做出不同判斷。

### Validation

- 驗證指令：`bun run --cwd /home/pkcs12/projects/opencode/packages/app typecheck`
- 結果：passed
- Architecture Sync: Verified (No doc changes)
  - 依據：本輪僅修正 session web surface 的 responsive breakpoint，未改變模組邊界、資料流或 runtime contract。
