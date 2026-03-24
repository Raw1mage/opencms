# Event: Google Calendar App Market MVP Implementation

## 需求

- 實作 app market / managed MCP registry 架構 MVP
- 以 Google Calendar 作為第一個 managed app，驗證架構路徑可行
- 參考 plan: `plans/20260324_googke-agent/`

## 範圍

### IN

- ManagedAppRegistry domain model、state machine、persistence、bus events
- Managed app REST API endpoints（list/get/install/uninstall/config/enable/disable/runtime/usage）
- MCP tool surface 整合（managed app tools → AI SDK dynamicTool）
- Google Calendar REST API client（raw fetch，不引入 googleapis 重型依賴）
- Google Calendar tool executors（7 tools: list-calendars, list-events, get-event, create-event, update-event, delete-event, freebusy）
- Canonical auth 整合（google-calendar provider → Account → Auth → OAuth access token）
- Account 系統新增 google-calendar provider key
- Registry + app structure 測試

### OUT

- Google Calendar OAuth connect flow UI
- 遠端 marketplace backend
- 第三方 app sandbox hardening
- smoke test（需要真實 Google OAuth token）

## Scope（引用 tasks.md）

- 5.1–5.10 全部完成
- 5.11 Web app market UI 完成

## Key Decisions

1. **Google Calendar REST API client 使用 raw fetch**：避免引入 googleapis 套件（~50MB），直接呼叫 `https://www.googleapis.com/calendar/v3/` endpoints。
2. **Auth 欄位使用 `auth.access`**：既有 Auth.Info OAuth 結構使用 `access` 而非 `accessToken`。
3. **Tool execute routing via managedAppExecutors map**：在 `mcp/index.ts` 中用 appId → executor 的 map 路由，支援未來多 app 擴充。
4. **Tool output 為 markdown 格式化字串**：讓 LLM 可直接呈現給使用者，不需額外格式化。
5. **delete-event 是唯一需要 confirmation 的 tool**（`requiresConfirmation: true`）。
6. **Fail-fast 原則**：tool 執行失敗會呼叫 `ManagedAppRegistry.markError()` 記錄 error state，不做 silent fallback。

## Issues Found

- `app-registry.ts` line 860 有 implicit any（`entry.requiredConfig.every((key) => ...)`），已修正為顯式型別。
- `bun install` 在 worktree 中因 build script 缺少 theme JSON 而失敗（pre-existing issue，不影響測試）。

## Verification

- TypeScript: `bun x tsc --noEmit` — 新增檔案零新增 type errors
- Tests: `bun test --preload ./packages/opencode/test/preload.ts packages/opencode/test/mcp/` — 23 pass, 0 fail (含 4 原有 MCP 測試 + 13 registry 測試 + 4 app 測試 + 2 其他)
- Fail-fast: 未安裝/未授權狀態呼叫 tool 會正確拋出 UsageStateError/AppNotFoundError

## Architecture Sync

Architecture Sync: Pending — managed app registry 架構邊界需同步至 `specs/architecture.md`。以下為需同步的變更：

### 新增模組邊界

- `packages/opencode/src/mcp/app-registry.ts` — Managed App Registry authority（catalog, install lifecycle, runtime status, persistence）
- `packages/opencode/src/mcp/apps/google-calendar/` — Google Calendar managed app service（client + tool executors）

### 新增 API Surface

- `GET /mcp/apps` — 列出所有 managed apps
- `GET /mcp/apps/:appId` — 取得單一 app snapshot
- `POST /mcp/apps/:appId/install|uninstall|config|enable|disable` — Lifecycle operations
- `GET /mcp/apps/:appId/runtime|usage` — Runtime/usage state queries

### State Machine

```
available → installing → installed → (configured + authenticated + enabled) → ready
                                   → error (recoverable via clearError)
                                   → disabled (via disable)
```

### Persistence

- `~/.config/opencode/managed-apps.json` — App install/config state（version 1 schema）

## 5.11 Web App Market UI Implementation

### 新增/修改檔案

- `packages/ui/src/components/icon.tsx` — 新增 `app-market` icon（4-square grid SVG）
- `packages/app/src/components/dialog-app-market.tsx` — Synology 風格 app market dialog（card grid, search, lifecycle actions）
- `packages/app/src/pages/layout/sidebar-shell.tsx` — sidebar 新增 market 按鈕（icon + tooltip）
- `packages/app/src/pages/layout.tsx` — wire dialog via `useDialog().show()`

### Key Decisions

7. **Synology Package Center 風格 UI**：card grid layout，每張卡顯示 app icon、名稱、描述、capability tags、status badge，以及安裝/啟用/停用/卸載動作按鈕。
8. **直接使用 `globalSDK.fetch`**：dialog 元件透過 SDK 的 fetch helper 呼叫 `/api/mcp/apps` REST endpoints，不另建 RPC 層。
9. **`createResource` + `refetch`**：lifecycle action 完成後自動重新載入 app 列表。

### Verification

- TypeScript: 新增前端檔案零 type errors（`tsc --noEmit --project packages/app/tsconfig.json`）
- Sidebar 按鈕位置：位於 open-project 下方、settings 上方

## Remaining

- [ ] Documentation sync to `specs/architecture.md`
- [ ] Google Calendar OAuth connect flow integration
- [ ] Smoke test with real Google account
- [ ] External MCP marketplace 串接
