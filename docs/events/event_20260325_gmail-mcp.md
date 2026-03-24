# Event: Gmail MCP Managed App

**Date**: 2026-03-25
**Branch**: `worktree-gmail-mcp` (beta worktree)
**Plan**: `plans/20260325_gmail-mcp/`

## Scope

### IN
- Gmail REST API client (raw fetch, 比照 Calendar)
- 10 tool executors (list-labels, list-messages, get-message, send-message, reply-message, forward-message, modify-labels, trash-message, list-drafts, create-draft)
- BUILTIN_CATALOG gmail entry
- OAuth connect/callback 泛化（Google app 白名單 + scope 合併 + 雙 app 連動）
- MCP routing map 加入 gmail executor
- `.env` + `.env.example` 新增 `GOOGLE_GMAIL_SCOPE`

### OUT
- 附件處理、Push/Pub/Sub、token refresh 改動、前端 UI 改動

## Key Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| DD-1 | Full scope `https://mail.google.com/` | 使用者明確要求 |
| DD-2 | 共用 `gauth.json` | 使用者明確要求不分 token |
| DD-3 | OAuth connect 合併所有已安裝 Google app scopes | 一次授權涵蓋所有 app |
| DD-4 | OAuth callback 連動 enable 所有 Google apps | 共用 token 連動生效 |
| DD-5 | Google OAuth app 白名單機制 | 可擴展但受控 |
| DD-6 | `operator.install === "installed"` 判斷 | `runtimeStatus` 不含 `available`，需用 `operator` 層 |

## Issues Found

- `runtimeStatus` type 不含 `"available"` — 初版用 `runtimeStatus !== "available"` 導致 TS2367，改為 `operator.install === "installed"`
- Line 209 of `mcp.ts` 有 pre-existing type error（`Property 'reason' does not exist`），非本次變更引入

## Verification

- TypeScript 型別檢查：通過（僅 pre-existing 的 line 209 error，非本次引入）
- 新增檔案 import paths：正確
- Calendar 既有 catalog entry：未修改
- OAuth routes：connect + callback 均泛化完成

## GCP Console Manual Steps Required

使用者需在 GCP Console 手動操作：
1. 啟用 Gmail API（APIs & Services → Enable APIs）
2. OAuth consent screen 加入 `https://mail.google.com/` scope
3. 加入 OAuth callback redirect URI: `https://cms.thesmart.cc/api/v2/mcp/apps/gmail/oauth/callback`
4. 重新 OAuth 授權以取得包含 Gmail scope 的新 token

## Architecture Sync

- `specs/architecture.md` 需新增 Managed App Registry 章節（目前不存在）
- 見 T6.2

## Remaining

- [ ] Commit worktree changes
- [ ] Syncback to cms branch
- [ ] GCP Console 手動操作
- [ ] End-to-end 測試（需 OAuth 授權後才能進行）
- [ ] `specs/architecture.md` Managed App 章節新增
