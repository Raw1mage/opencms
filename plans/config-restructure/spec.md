# Spec: Config Restructure

## Purpose

- 讓 config 系統在部分檔案損毀時仍能啟動主 daemon、避免 raw config text 外洩到 UI，並把 provider availability 從手動 denylist 改為從 `accounts.json` 衍生

## Requirements

### Requirement: Daemon survives config parse failure

The system SHALL continue serving requests using a last-known-good snapshot when the primary `opencode.json` fails to parse.

#### Scenario: opencode.json 被誤 append 非法字元
- **GIVEN** `~/.config/opencode/opencode.json` 檔尾多了無效字元導致 JSONC parse error
- **AND** `~/.local/state/opencode/lkg.json` 存在且上次成功
- **WHEN** daemon 啟動或下一個 HTTP request 觸發 `Config.get()`
- **THEN** daemon 必須讀取 lkg 繼續運作，`log.warn` 明確寫出「使用 lkg 路徑、原檔 parse 失敗位置」，並且回應帶 `configStale: true` 旗標

#### Scenario: lkg 不存在且主檔壞掉
- **GIVEN** `opencode.json` parse 失敗
- **AND** lkg 檔案不存在（首次安裝或使用者手動刪除）
- **WHEN** HTTP request 觸發 `Config.get()`
- **THEN** 回應 HTTP 503 `{ code, path, line, column, hint }`，daemon process 本身不因此退出

### Requirement: HTTP error response never leaks raw config text

The system SHALL NOT include full config file contents in any HTTP response body when config parsing fails.

#### Scenario: config parse error 觸發 HTTP error
- **GIVEN** `ConfigJsonError` 或 `ConfigInvalidError` 被 throw
- **WHEN** `server/app.ts` `onError` handler 處理該錯誤
- **THEN** response status 為 503（非 500），body 僅含 `{ code, path, line, column, hint }` 結構化欄位，絕不包含原檔 text 或 `message` 全文
- **AND** daemon-side `log.error` 會印完整 debug snippet（±3 行 context）供 operator 檢視

### Requirement: Webapp never renders raw config text on error

The system SHALL render a structured ErrorBoundary for `/global/config` failures without ever rendering the response body as text.

#### Scenario: webapp 收到 503 config error
- **GIVEN** webapp 對 `/global/config` 發起 fetch
- **WHEN** 回應為 503
- **THEN** UI 必須渲染 ErrorBoundary card 顯示 `code`、`path`、`line`、`hint`，不得以 `innerText` 或類似方式輸出 raw body

### Requirement: Provider availability derives from accounts.json

The system SHALL derive provider enabled/disabled state from `accounts.json` with optional user override in `providers.json`.

#### Scenario: provider 無帳號
- **GIVEN** provider `foo` 在 `accounts.json` 無任何帳號
- **AND** `providers.json` 無手動 override
- **WHEN** `providerAvailability("foo")` 被呼叫
- **THEN** 回傳 `"no-account"`，實際行為視為 disabled，且 `log.info` 記錄「provider foo 因無帳號 disabled」

#### Scenario: provider 有帳號但使用者手動停用
- **GIVEN** provider `bar` 在 `accounts.json` 有 1+ 個帳號
- **AND** `providers.json` 內標註 `bar` 為 override-disabled
- **WHEN** `providerAvailability("bar")` 被呼叫
- **THEN** 回傳 `"disabled"`（override 優先於帳號狀態）

#### Scenario: 舊版 disabled_providers 仍存在
- **GIVEN** 使用者尚未執行 migration，`opencode.json` 內 `disabled_providers` 仍有 109 筆
- **WHEN** daemon 啟動
- **THEN** `disabled_providers` 仍被讀取並當作 override 合併；`log.info` 提示建議 migrate

### Requirement: Sub-file parse failure isolated to its section

The system SHALL isolate parse failures of `providers.json` / `mcp.json` so that failure in one section does not block daemon boot or other sections.

#### Scenario: mcp.json 損毀
- **GIVEN** `~/.config/opencode/mcp.json` 包含無效 JSON
- **WHEN** daemon 啟動並嘗試讀取 config
- **THEN** daemon 啟動成功、主 UI 活、MCP 全 disable、`log.warn` 記錄「mcp.json 失敗、mcp subsystem 停用」

#### Scenario: providers.json 損毀
- **GIVEN** `providers.json` 包含無效 JSON
- **WHEN** daemon 啟動
- **THEN** provider section 走 lkg（若有）或空集，其他功能正常，`log.warn` 記錄替代來源

### Requirement: Backward compatibility with single-file config

The system SHALL continue to read legacy single-file `opencode.json` (containing `provider` / `mcp` inline) for at least one release cycle.

#### Scenario: 尚未執行 split migration
- **GIVEN** 使用者的 `opencode.json` 仍是舊單檔格式，`providers.json` / `mcp.json` 不存在
- **WHEN** daemon 啟動
- **THEN** 以舊單檔格式解析、功能正常、`log.info` 提示執行 `scripts/migrate-config-split.ts`

### Requirement: All fallbacks comply with AGENTS.md rule #1

The system SHALL NOT silently fall back on any config load path; every fallback must log its reason explicitly.

#### Scenario: 任一 fallback 被觸發
- **GIVEN** daemon 走 lkg、空集、或 `disabled_providers` 舊格式
- **WHEN** fallback 發生
- **THEN** daemon log 必須含 `log.warn` 或 `log.info` 明確寫出「失敗路徑、替代來源、為什麼走這條路」，使 operator 能從 log 立即發現

## Acceptance Checks

- 手動 append 垃圾到 `opencode.json` → daemon 不 crash、webapp 顯示 friendly error、不含原文
- 刪除 `~/.local/state/opencode/lkg.json` → 首次 config 壞掉回 503、daemon 不退出
- `bun run scripts/migrate-disabled-providers.ts --dry-run` 輸出「可刪 X 筆、保留 Y 筆」
- 刪除整個 `disabled_providers` 後 `/provider` 列表語意不變
- `mcp.json` 改成無效 JSON → daemon boot 成功、MCP 全 disable
- `providers.json` 改成無效 JSON → daemon boot 成功、其他功能正常
- `templates/**` 與 runtime 欄位一對一同步
- 所有 fallback 均在 daemon log 中可見（無靜默 fallback）
- `specs/architecture.md` config subsystem 段落已更新
