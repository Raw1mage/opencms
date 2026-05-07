# 2026-05-05 Session title metadata tool

## 需求

- 使用者指出：agent 應能透過 system-manager 讀取與設定 session 標題；目前只有 `rename_session` 可設定，缺少可靠讀取 title 的 tool surface。

## 範圍(IN)

- 補上 read-only session metadata tool，回傳 session title / directory / timestamps / execution identity。
- 沿用 daemon session API 邊界，不讀取 storage fallback。
- 同步架構文件與驗證紀錄。

## 範圍(OUT)

- 不改 session storage schema。
- 不改 Web UI session list 行為。
- 不新增 title 推測或 silent fallback。

## 任務清單

- [x] Baseline：確認 `GET /api/v2/session/:id` 已可回傳 `Session.Info`，且 system-manager 已有 `readSessionInfoFromDaemon` helper。
- [x] Implementation：新增 `get_session` MCP tool，輸出 JSON metadata。
- [x] Validation：執行 system-manager 相關 typecheck/lint 或最小編譯檢查。

## Debug checkpoints

### Baseline

- 症狀：詢問「session 標題是什麼」時，agent 只能看到 sessionID，`manage_session(list)` 只回 `Opening session list UI...`，沒有資料型 title 回傳。
- 影響範圍：system-manager MCP session metadata read surface。

### Instrumentation Plan

- Boundary 1：MCP tool list 是否有 dedicated read-only session metadata tool。
- Boundary 2：MCP handler 是否使用 daemon `/api/v2/session/:id` 而非 storage fallback。
- Boundary 3：tool output 是否包含 title 與必要 session metadata。

### Execution Evidence

- `packages/opencode/src/server/routes/session.ts` 已有 `GET /session/:sessionID`，回傳 `Session.Info`。
- `packages/mcp/system-manager/src/system-manager-http.ts` 已有 `readSessionInfoViaApi(...)`。
- `packages/mcp/system-manager/src/index.ts` 已有 `readSessionInfoFromDaemon(...)`，create handover path 也已使用該 helper。

### Root Cause

- Session metadata read path 已存在，但 MCP tool surface 只提供 mutate-oriented `rename_session` 與 UI-oriented `manage_session(list)`；缺少 agent 可直接讀 title 的 structured tool。

### Validation

- `bun --check "packages/mcp/system-manager/src/index.ts"`：passed（無錯誤輸出）。
- `bun eslint "packages/mcp/system-manager/src/index.ts"`：passed（無錯誤輸出）。
- Capability refresh accepted `system-manager_get_session` via `tool_loader`; current static function schema did not expose the callable in this already-running turn, so live invocation must be rechecked after next MCP/tool-schema refresh or controlled restart.

## Architecture Sync

- Updated `specs/architecture.md` Tool Surface Runtime section to record `get_session` as the dedicated read-only session metadata tool and `rename_session` as the mutation tool.

## XDG backup

- Created pre-edit whitelist backup: `/home/pkcs12/.config/opencode.bak-20260505-1724-session-title-metadata`.
