# Implementation Spec

## Goal

在 Managed App 架構下新增 `gmail` app，提供 10 個 tools 讓使用者透過 AI session 存取 Gmail，並泛化 Google OAuth flow 支援多 app 共用 token。

## Scope

### IN

- Gmail REST API client + 10 tool executors
- BUILTIN_CATALOG gmail entry + MCP routing
- OAuth connect/callback 泛化（Google app 白名單 + scope 合併 + 雙 app 連動）
- `.env` 新增 `GOOGLE_GMAIL_SCOPE`

### OUT

- 附件處理、Push/Pub/Sub、token refresh 改動、前端 UI 改動

## Assumptions

- 同一 GCP 專案（gen-lang-client-0857568615）可同時啟用 Calendar + Gmail API
- OAuth consent screen 加入新 scope 後，使用者重新授權即可取得 full access
- App Market 前端已泛化，新增 catalog entry 後自動顯示

## Stop Gates

- GCP Console 未啟用 Gmail API → 需使用者手動操作後才能測試
- OAuth re-auth 後 Calendar 功能異常 → 需確認 scope 合併正確性
- Build 有 type error → 修復後才能進入驗證

## Critical Files

- `packages/opencode/src/mcp/apps/gmail/client.ts` (NEW)
- `packages/opencode/src/mcp/apps/gmail/index.ts` (NEW)
- `packages/opencode/src/mcp/app-registry.ts` (MODIFY — BUILTIN_CATALOG)
- `packages/opencode/src/mcp/index.ts` (MODIFY — routing map)
- `packages/opencode/src/server/routes/mcp.ts` (MODIFY — OAuth generalization)
- `.env` (MODIFY — add GOOGLE_GMAIL_SCOPE)

## Structured Execution Phases

- Phase 1 — Core Implementation: Gmail client + tool executors（已有草稿）
- Phase 2 — Registry & Routing: BUILTIN_CATALOG entry + MCP executor routing
- Phase 3 — OAuth Generalization: connect/callback 泛化 + scope 合併 + 雙 app 連動
- Phase 4 — Environment: `.env` 新增 Gmail scope
- Phase 5 — Validation: build 驗證 + GCP 手動步驟記錄
- Phase 6 — Documentation: event log + architecture sync

## Validation

- `bun build` 無 type error
- Gmail app 在 App Market 可見、可安裝
- OAuth connect 後 `gauth.json` 包含 Calendar + Gmail scopes
- 10 個 tools 可透過 AI session 呼叫（至少驗證 list-labels, list-messages, send-message）
- 既有 Calendar tools 不受影響

## Handoff

- Build agent must read this spec first.
- Build agent must read companion artifacts before coding.
- Build agent must materialize runtime todo from tasks.md.
- Phase 1 已有草稿檔案（`gmail/client.ts`, `gmail/index.ts`），需 review 後整合。
