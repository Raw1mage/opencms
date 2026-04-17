# Proposal: Config Restructure — opencode.json 拆檔與防線

## Why

- 2026-04-17 事故：`~/.config/opencode/opencode.json` 檔尾被誤 append 6 bytes（`script`），觸發 JSONC parse error
- Daemon 直接無法啟動，webapp 把整份 10878 bytes raw config text 原文渲染到畫面，形成「密密麻麻的 crash 畫面」
- 事故暴露三層同時缺乏防線：config loader throw 整份原文、HTTP onError 原樣回傳、webapp fetch handler 直接 innerText
- `opencode.json` 單檔責任過重：一處壞掉整個 daemon 死，且 109 筆 `disabled_providers` 手動維護成本高

## Original Requirement Wording (Baseline)

- "opencode.json 被錯誤 append 了六個字元之後，整個 webapp 直接顯示 crash 畫面把 config 原文印出來"
- "這檔案太肥、太關鍵、壞一個地方全死，要拆"
- "disabled_providers 有 109 筆，但我已經有 accounts.json，為什麼還要手動維護"

## Requirement Revision History

- 2026-04-17 初稿：三個 Phase，涵蓋 server 防線 / denylist 衍生 / 拆檔
- 2026-04-17 rev1：使用者確認 scope = 全部三個 Phase、LKG 路徑 = `~/.local/state/opencode/lkg.json`、override 位置 = 新 `providers.json`、webapp 範圍 = 只修 `/global/config`
- 2026-04-17 rev2：MCP lifecycle 驗證結果 = MCP 連線已 lazy（first message 才觸發），Phase 3 可行不需 preflight

## Effective Requirement Description

1. Config parse 失敗時，daemon 用 last-known-good 快照繼續運作；webapp 只顯示 friendly error，不得渲染 raw config text
2. `opencode.json` 瘦身到 < 500 bytes，僅保留 boot-critical 低頻變更 key（`$schema`、`plugin`、`permissionMode`）
3. `provider` 與 `mcp` 拆成獨立檔案，單檔解析失敗只影響該子系統，主 UI 仍活
4. `disabled_providers` 由 `accounts.json` 執行期衍生；`providers.json` 可放少量 user override
5. 所有 fallback 路徑須符合 AGENTS.md 第一條：明確 log.warn 寫清楚用了什麼替代、原檔錯在哪

## Scope

### IN

- Config parse 失敗防線：`JsonError` 瘦身、status code 503、last-known-good snapshot 機制
- Webapp `/global/config` 這條路徑的 fetch error boundary
- `disabled_providers` 由 `accounts.json` 衍生的 availability 模組
- 拆檔：`opencode.json` / `providers.json` / `mcp.json`
- Migration 腳本（denylist cleanup + split）
- `templates/**` 範本同步

### OUT

- 重寫 `Config` namespace loader 機制（僅擴充，不重寫）
- 改動 `accounts.json` 結構
- 把 `permissionMode` 拆出去（boot-critical，留主檔）
- Hot-reload config
- 其他 API 的 fetch error boundary（只限本次 `/global/config`）

## Non-Goals

- 不改 `Config.Info` 對外 schema 形狀
- 不做 MCP lifecycle 重構（已驗證 lazy）
- 不處理其他 webapp 全站 fetch error 統一化（另排 ticket）

## Constraints

- AGENTS.md 第零條：本文件即為 plan；Phase 1 雖具 hotfix 性質仍須寫在 plan 中留痕
- AGENTS.md 第一條：所有 fallback 必須 log.warn 明確記錄
- `Config.get()` 對外 API 完全不變，僅底層多檔合併
- 向後相容：舊單檔 `opencode.json` 讀取能力至少保留一個 release cycle
- Release 前檢查清單：`templates/**` 與 runtime 同步、`docs/events/` 留痕、`specs/architecture.md` 同步

## What Changes

- `packages/opencode/src/config/config.ts` — `JsonError` 結構、新增 last-known-good snapshot、`loadSplit` 多檔合併
- `packages/opencode/src/server/app.ts` — `ConfigJsonError` / `ConfigInvalidError` → 503，body 不含原文
- `packages/opencode/src/provider/availability.ts`（新）— provider availability 推導
- `packages/app/src/context/sdk.tsx`（待 audit 確認路徑）— `/global/config` 錯誤處理
- `templates/opencode.json` / `templates/providers.json` / `templates/mcp.json` — 新範本
- `scripts/migrate-disabled-providers.ts` / `scripts/migrate-config-split.ts` — 遷移腳本

## Capabilities

### New Capabilities

- **Last-Known-Good Fallback**: daemon 於 config parse 失敗時使用 `~/.local/state/opencode/lkg.json` 繼續運作
- **Provider Availability Derivation**: 從 `accounts.json` 自動推導 provider 可用性
- **Section-Level Config Isolation**: 單個 sub-file 解析失敗只影響該 section

### Modified Capabilities

- **Config Error Response**: `ConfigJsonError` 回應不再攜帶原檔全文，改為結構化 `{ code, path, line, column, hint }`
- **Webapp Config Error Rendering**: `/global/config` 路徑改用 ErrorBoundary 呈現結構化錯誤

## Impact

- Daemon boot path：新增 lkg 讀寫、parse 失敗不再 fatal
- HTTP API：`/config`、`/provider` 500 → 503，response body schema 變動（新增 `code`、移除 `message` 原文）
- Webapp：`/global/config` 錯誤態 UI 重繪
- Operator：新增 `/etc/opencode` 相關變更（如需）、遷移腳本操作流程
- Docs：`docs/events/2026-04-17_config_crash.md`、`specs/architecture.md` 同步
