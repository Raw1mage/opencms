# Implementation Spec

## Goal

- 以 3 Phase 交付 config 防線與拆檔：daemon 於 config parse 失敗時走 last-known-good 快照繼續運作、`disabled_providers` 由 `accounts.json` 衍生、`opencode.json` 拆成 `providers.json` + `mcp.json`，且所有 fallback 符合 AGENTS.md 第一條（明確 log.warn）。

## Scope

### IN

- Phase 1：`JsonError` 瘦身、HTTP 503、LKG snapshot 於 `~/.local/state/opencode/lkg.json`、`/global/config` 路徑 ErrorBoundary
- Phase 2：`provider/availability.ts` 模組、`accounts.json` 推導、`disabled_providers` 向後相容讀取、migration dry-run 腳本
- Phase 3：`loadSplit` 多檔合併、`providers.json` / `mcp.json` 拆檔、`templates/**` 同步、migration 腳本
- 全部 Phase：`docs/events/` 留痕、AGENTS.md 合規檢查

### OUT

- 重寫 `Config` namespace loader
- 改動 `accounts.json` schema
- 把 `permissionMode` 拆離主檔
- 其他 webapp fetch error 路徑（非 `/global/config`）
- MCP lifecycle 重構（已驗證 lazy）

## Assumptions

- MCP 連線目前已 lazy：首次 message 才觸發 `MCP.tools()` → `connectMcpApps()`（[mcp/index.ts:199-264](../../packages/opencode/src/mcp/index.ts#L199-L264)、[session/resolve-tools.ts:221](../../packages/opencode/src/session/resolve-tools.ts#L221)）。Phase 3 可行。
- `Config.get()` 對外 API 形狀不變 — 所有 consumer（`/config`、`/provider`、`resolveTools`）不需改碼
- `~/.local/state/opencode/` 目錄由 daemon 自動建立（若不存在）
- Webapp `/global/config` 錯誤路徑在 `packages/app/src/context/sdk.tsx` 附近（需 audit 確認）

## Stop Gates

- **Phase 1 完成前**：不得進 Phase 3（Phase 3 的 sub-file 錯誤隔離依賴 Phase 1 的 lkg 機制）
- **Webapp audit 未完成**：不得修改 webapp 前先 grep 確認 `/global/config` 錯誤渲染路徑，避免改錯檔
- **Template drift**：Phase 3 若未同步 `templates/**`，不得標記 Phase 3 完成
- **Migration 破壞性操作**：`scripts/migrate-*.ts` 執行前必須支援 `--dry-run`，且使用者明確確認 diff 後才寫回
- **向後相容 regression**：若舊單檔 `opencode.json` 讀取能力破壞，必須回滾
- **Scope creep**：若遇到需重寫 `Config` loader 的場景，停下回 planner

## Critical Files

- [packages/opencode/src/config/config.ts](../../packages/opencode/src/config/config.ts) — `JsonError` 結構、`state()`、`load()`、`loadFile()`，Phase 1/3 核心
- [packages/opencode/src/server/app.ts](../../packages/opencode/src/server/app.ts) — `onError` handler（~L83-L90），Phase 1 status code / response body
- [packages/opencode/src/provider/availability.ts](../../packages/opencode/src/provider/availability.ts) — 新增，Phase 2 核心
- [packages/app/src/context/sdk.tsx](../../packages/app/src/context/sdk.tsx) — 待 audit，Phase 1 webapp 側改動
- [templates/opencode.json](../../templates/opencode.json) / [templates/providers.json](../../templates/providers.json) / [templates/mcp.json](../../templates/mcp.json) — Phase 3 新範本
- [scripts/migrate-disabled-providers.ts](../../scripts/migrate-disabled-providers.ts) — Phase 2 新遷移腳本
- [scripts/migrate-config-split.ts](../../scripts/migrate-config-split.ts) — Phase 3 新遷移腳本
- [docs/events/2026-04-17_config_crash.md](../../docs/events/2026-04-17_config_crash.md) — 事故留痕
- [specs/architecture.md](../../specs/architecture.md) — Phase 3 完成後同步

## Structured Execution Phases

- **Phase 1 — Server-side 防線（0.5 天）**：`JsonError` 瘦身、`/global/config` 503 回應、LKG snapshot 讀寫、webapp ErrorBoundary
- **Phase 2 — disabled_providers 衍生（1 天）**：`provider/availability.ts` 新增、`accounts.json` 推導、向後相容讀 `disabled_providers`、`migrate-disabled-providers.ts --dry-run`
- **Phase 3 — 拆檔 providers.json / mcp.json（2 天）**：`loadSplit` 多檔合併、section-level 錯誤隔離、`templates/**` 同步、`migrate-config-split.ts`、`docs/events/` + `specs/architecture.md` 更新

## Validation

- **Phase 1**：
  - 手動 append 垃圾字元到 `~/.config/opencode/opencode.json` → daemon 啟動不 crash、使用 lkg、`log.warn` 寫出錯誤位置
  - `curl /config` 回 503，body 為 `{ code, path, line, column, hint }`，不含原文
  - Webapp `/global/config` 顯示 ErrorBoundary，檢視 DOM 確認無 raw config text
  - 刪除 lkg → 首次 parse 失敗時回 503 但 daemon 不當掉後續請求
- **Phase 2**：
  - `bun run scripts/migrate-disabled-providers.ts --dry-run` 列出「可刪 X 筆、保留 Y 筆 override」
  - 刪除 `disabled_providers` 後 `/provider` 列表與之前語意一致（snapshot diff）
  - 新增一個有 `accounts.json` 帳號的 provider → 自動 enabled；移除帳號 → 自動 disabled
- **Phase 3**：
  - `providers.json` 壞掉 → daemon boot 成功、`/provider` 回空或 lkg、其他 API 正常
  - `mcp.json` 壞掉 → daemon boot 成功、MCP 全 disable、主 UI 活
  - 三檔合併結果與原單檔語意相等（unit test：同 fixtures 比對 `Config.get()` 輸出）
  - `templates/**` 與 runtime config 欄位一對一同步（檢查腳本或手動 diff）
  - `specs/architecture.md` 已更新 config subsystem 段落

## Handoff

- Build agent 必須先讀 `implementation-spec.md`
- Build agent 必須讀 `proposal.md` / `spec.md` / `design.md` / `tasks.md`，以及 `specs/architecture.md`
- 從 `tasks.md` 材料化 runtime todo；不得自編平行 checklist
- 每個 Phase 內部若發現需重寫 `Config` loader，停下回 planner；不得擅自擴大 scope
- Phase 完成後更新 `handoff.md` 的 Current State、打勾 `tasks.md`、追加 `docs/events/` 條目
