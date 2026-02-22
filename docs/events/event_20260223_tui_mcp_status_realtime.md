# Event: TUI MCP taskbar status realtime sync

Date: 2026-02-23
Status: Done

## 1. Symptom

- 使用 `system-manager toggle_mcp` 後，TUI taskbar 的 MCP 狀態未即時更新。

## 2. Root Cause

- TUI 的 `sync.data.mcp` 主要在 bootstrap 或 Dialog MCP 手動 toggle 後才 refresh。
- 外部改寫 `opencode.json`（例如 system-manager）沒有觸發 TUI MCP 狀態刷新。

## 3. Changes

- `packages/opencode/src/cli/cmd/tui/context/local.tsx`
  - MCP 狀態刷新重構為共享 API（`refreshMcpStatus`）。
  - 新增 in-flight/pending 併發保護，避免重複 refresh 競態。
  - 新增 `scheduleMcpStatusRefresh`（watcher debounce），避免 config 連續寫入造成 UI 抖動。
  - `mcp.toggle()` 內建刷新，讓呼叫端不需重複寫 refresh 邏輯。
- `packages/opencode/src/cli/cmd/tui/context/sync.tsx`
  - 新增 `mcp.tools.changed` 事件處理，收到事件時同步刷新 `sync.mcp`。
- `packages/opencode/src/cli/cmd/tui/component/dialog-mcp.tsx`
  - 移除重複的 `sdk.client.mcp.status()` 呼叫，改由 `local.mcp.toggle()` 統一處理刷新。

## 4. Refactor Plan (Executed)

1. 同步入口統一：已完成（集中到 local context）。
2. 事件驅動補強：已完成（`mcp.tools.changed` refresh）。
3. watcher 去抖與容錯：已完成（debounce + safe refresh）。
4. UI 顯示一致性：已完成（dialog/taskbar/sidebar 共用 `sync.data.mcp`）。

## 5. Validation

- 依使用者要求：略過 `antigravity auth plugin` 相關噪音驗證，不以其失敗阻擋本次變更。
