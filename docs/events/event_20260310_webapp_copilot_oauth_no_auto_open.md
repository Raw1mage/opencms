# Event: provider OAuth dialogs stop auto-opening browser

Date: 2026-03-10
Status: Completed

## 需求

- 修正 provider OAuth 認證 UX。
- 所有平台情境（web / TUI，並與 mobile / PC 使用習慣保持一致）一律不要自動開啟瀏覽器頁面；改為顯示可點擊或可複製的連結，讓使用者自行決定何時開啟。

## 範圍 (IN / OUT)

### IN

- `packages/app/src/components/dialog-connect-provider.tsx`
- `packages/opencode/src/cli/cmd/tui/component/dialog-provider.tsx`
- web / TUI provider connect dialog 的 OAuth 顯示行為

### OUT

- 後端 OAuth device-code protocol
- 其他 provider 的 callback 協議
- 非 provider-auth 用途的外部連結開啟行為

## 任務清單

- [x] 盤點 web / TUI provider OAuth 自動開頁路徑
- [x] 將 web `code` / `auto` OAuth view 改為只顯示連結，不主動開頁
- [x] 移除 TUI provider OAuth 的主動開頁快捷與預設 opening 文案
- [x] 補 regression test，鎖定全域 no-auto-open 規格
- [x] 驗證前端與 opencode 型別檢查、app 單元測試
- [x] 完成 architecture sync 檢查

## Debug Checkpoints

### Baseline

- 症狀：provider OAuth 流程在部分情境會主動打開瀏覽器，打斷使用者先閱讀 code / link 的節奏，也不利於 mobile、PC、TUI 等不同操作習慣統一。
- 重現路徑：provider connect dialog → 選 OAuth method。
- 影響範圍：web `DialogConnectProvider` 與 TUI `dialog-provider`。
- 初始假設：web / TUI 內部存在 mount-time open 或 keyboard shortcut open。

### Instrumentation Plan

- 檢查 web provider connect 入口是否共用 `DialogConnectProvider`。
- 檢查 web `OAuthAutoView` / `OAuthCodeView` 是否在 `onMount` 觸發 `platform.openLink(...)`。
- 檢查 TUI provider dialog 是否提供 `open(...)` 捷徑或預設 opening 流程。
- 以「一律不自動開頁」為新規格，移除 provider-specific 分支與多餘 contract。

### Execution

- 在 `packages/app/src/components/dialog-connect-provider.tsx` 確認：
  - `OAuthCodeView` 會自動開頁。
  - `OAuthAutoView` 也會在 mount 時執行 `platform.openLink(store.authorization.url)`。
- 在 `packages/opencode/src/cli/cmd/tui/component/dialog-provider.tsx` 確認：
  - `CodeMethod` 仍保留 `alt+o` 開瀏覽器。
  - provider 導入頁面仍顯示 `Opening authentication...`。
- 依使用者新規格，將 provider-specific 與 capability-flag 方案全部回收，直接收斂成單一 policy：所有 provider OAuth dialog 一律不自動開頁。
- web 保留可點連結；TUI 保留 link 與 copy-url 操作。
- 補上 `packages/app/src/components/dialog-connect-provider.test.ts`，鎖定 global no-auto-open policy。

### Root Cause

- 真正根因是 provider auth UI 把「幫使用者開頁」視為預設便利行為，分散在 web mount side effect 與 TUI keyboard shortcut 中。
- 這種自動化在 device-code、跨裝置、mobile、桌面多視窗與 TUI 等情境下都不穩定，且會打斷使用者先閱讀 code / link 的節奏。
- 因此問題不該用 provider-specific 例外處理，而應直接收斂成產品層級 policy：provider OAuth dialog 一律只提供連結與複製能力，不主動開頁。

### Validation

- 指令：`bun x tsc --noEmit --project packages/app/tsconfig.json`
- 結果：passed
- 指令：`bun x tsc --noEmit --project packages/opencode/tsconfig.json`
- 結果：passed
- 指令：`bun test --preload ./happydom.ts ./src`
- 結果：291 pass / 5 skip / 0 fail
- Architecture Sync: Verified (No doc changes)
  - 依據：本次僅統一 provider auth dialog 的互動 policy（取消自動開頁），未改變架構邊界、資料流拓撲、OAuth callback protocol 或 runtime ownership。

## Files Changed

- `packages/app/src/components/dialog-connect-provider.tsx`
  - 移除 `OAuthCodeView` / `OAuthAutoView` 的自動開頁 side effect。
  - 保留連結顯示與 callback polling。
- `packages/app/src/components/dialog-connect-provider.test.ts`
  - 驗證 global no-auto-open policy。
- `packages/opencode/src/cli/cmd/tui/component/dialog-provider.tsx`
  - 移除 `alt+o` 開瀏覽器快捷與 opening 文案，保留 link 與 copy-url 操作。
- `packages/plugin/src/index.ts`
- `packages/opencode/src/provider/auth.ts`
- `packages/sdk/js/src/gen/types.gen.ts`
- `packages/sdk/js/src/v2/gen/types.gen.ts`
- `packages/opencode/src/plugin/copilot.ts`
  - 回收上一輪為 auto-open capability flag 引入的暫時性 contract，恢復乾淨單一規格。
