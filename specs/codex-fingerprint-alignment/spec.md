# Spec: codex-fingerprint-alignment

## Purpose

讓 opencode-codex-provider 對 `https://chatgpt.com/backend-api/codex/responses`（HTTP SSE + WebSocket）送出的請求 fingerprint 對齊 upstream `refs/codex@rust-v0.125.0-alpha.1`，使 OpenAI 第一方分類器把本 plugin 視為 first-party，將後台觀察到的第三方判定比例從 ~7% 壓至接近 0%，同時不回歸既有成功路徑。

## Definitions

- **first-party classifier**：OpenAI 後端依 UA、originator、account-id header、版本等組合判定請求來源是否為自家 codex CLI 的機制。
- **fingerprint**：單一出站請求在 OpenAI 伺服器看到的 header + body 欄位組合（不含 TLS/JA3 層，不在本 spec 範圍）。
- **Current UA**：`codex_cli_rs/<CODEX_CLI_VERSION> (<Platform> <OS release>; <arch>) terminal`，由 `buildCodexUserAgent()` 產生；格式必須與 `originator` 前綴相同。
- **WS transport**：`transport-ws.ts` 建立的 WebSocket 升級 + 首訊息 JSON 路徑。
- **HTTP transport**：`provider.ts` 的 SSE fallback 路徑（POST + `text/event-stream` 回傳）。

## Requirements

### Requirement: WS upgrade 請求帶有 upstream 對齊的 User-Agent

本 plugin 透過 WebSocket 發起的升級請求，其 header 必須包含與 HTTP 路徑一致的 `User-Agent`，格式與 `originator` 對齊。

#### Scenario: WS 建立連線時

- **GIVEN** 使用者以 codex OAuth credentials 發起一次對話
- **AND** WS transport 嘗試建立 `wss://chatgpt.com/backend-api/codex/responses` 連線
- **WHEN** plugin 發出 WebSocket 升級請求
- **THEN** 升級 header 必須包含 `User-Agent`，值等同 `buildCodexUserAgent()` 的輸出（格式：`codex_cli_rs/<ver> (<OS> <release>; <arch>) terminal`）
- **AND** `User-Agent` 的 prefix 必須與 `originator` header 值相同（`codex_cli_rs`）

### Requirement: ChatGPT-Account-Id header 使用 TitleCase

WS 與 HTTP 兩條路徑送出的 `ChatGPT-Account-Id` header 名稱必須與 upstream 一致，使用 TitleCase 而非 lowercase。

#### Scenario: 已綁定 ChatGPT 帳號的請求

- **GIVEN** credentials 內含 `accountId`
- **WHEN** plugin 發出任一出站請求（WS 或 HTTP）
- **THEN** header 鍵名必須為 `ChatGPT-Account-Id`（TitleCase；`C`、`G`、`P`、`T`、`A`、`I` 大寫）
- **AND** 現有 HTTP 路徑行為維持 TitleCase（不回歸）

### Requirement: refs/codex submodule 鎖定至 rust-v0.125.0-alpha.1 tag

`refs/codex` submodule pointer 必須指向 upstream tag `rust-v0.125.0-alpha.1` commit，而非 rolling HEAD。

#### Scenario: 同步完成後的狀態檢查

- **GIVEN** Phase 3 執行完畢
- **WHEN** 檢查 `refs/codex` submodule 的 commit
- **THEN** `git -C refs/codex describe --tags --exact-match HEAD` 回傳 `rust-v0.125.0-alpha.1`
- **AND** `packages/opencode-codex-provider/src/protocol.ts` 的 `CODEX_CLI_VERSION` 常數更新為 `rust-v0.125.0-alpha.1` 對應的語意版本（若 upstream `workspace.package.version` 為 `0.0.0`，採用 `0.125.0-alpha.1` 或 `0.125.0` 作為字面值）
- **AND** 若同步後 upstream 新增任何必要（非 conditional）header / body 欄位，記入本 spec 的 follow-up 或觸發新的 Requirement

### Requirement: WS 與 HTTP 共用單一 header builder 入口

重構完成後，所有 codex 出站請求的 header 必須透過 `buildHeaders()` 單一入口產生，消除 `transport-ws.ts` 內嵌的 header 組裝。

#### Scenario: WS 走 buildHeaders 路徑

- **GIVEN** Phase 2 完成
- **WHEN** WS transport 建立連線並組裝升級 header
- **THEN** header 物件必須由呼叫 `buildHeaders({ ..., isWebSocket: true, userAgent })` 產生
- **AND** `transport-ws.ts` 內不再存在直接 `headers["X"] = ...` 的 inline 建構（除非是 WS library 要求的 transport-layer header，如 `Sec-WebSocket-*`）

#### Scenario: HTTP 保持走 buildHeaders

- **GIVEN** Phase 2 完成
- **WHEN** HTTP fallback 發出 POST 請求
- **THEN** 既有 `provider.ts:211` 的 `buildHeaders()` 呼叫位置維持不變，語意等價（header 集合不減）

### Requirement: 補齊 x-client-request-id 與 Accept header

HTTP transport 需顯式送出 upstream 有、但本 plugin 原本缺的兩個 header。

#### Scenario: HTTP 發出請求

- **GIVEN** Phase 4 完成
- **AND** 目前有一個 `conversationId` 在此次請求的 session state
- **WHEN** plugin 發出 HTTP POST
- **THEN** header 必須包含 `x-client-request-id`，值等於 `conversationId`
- **AND** header 必須包含 `Accept: text/event-stream`（不仰賴 fetch 預設值）

#### Scenario: WS 路徑不受 Accept 影響

- **GIVEN** Phase 4 完成
- **WHEN** plugin 走 WS transport
- **THEN** WS 升級的 `Accept` 由 `tungstenite` / Bun 的 WS 實作控制（不受本 Requirement 影響）
- **AND** `x-client-request-id` 同樣套用到 WS 升級 header（值規則同上）

## Acceptance Checks

1. **Unit-level**
   - `headers.test.ts`：新增 case 覆蓋 `isWebSocket=true` 的輸出包含 `User-Agent`、TitleCase `ChatGPT-Account-Id`、`x-client-request-id`（Phase 4 後）。
   - `provider.test.ts`：既有 HTTP header 測試不回歸，新增 `Accept: text/event-stream` 斷言（Phase 4 後）。
   - `transport-ws.test.ts`（若尚未存在，Phase 2 建立）：驗證 WS 升級 header 集合等同 `buildHeaders({ isWebSocket: true })`。

2. **Build-level**
   - `bun run build` 成功；無 TypeScript 型別錯誤。
   - `bun test packages/opencode-codex-provider` 全綠。

3. **Integration-level（beta worktree）**
   - 在 beta worktree 啟動 daemon，以 codex OAuth 帳號發起一組典型對話（含 tool use、長 context）。
   - daemon log 應出現 `[CODEX-WS] REQ` / `[CODEX-HTTP] REQ` 紀錄，且抓出的 outbound header 組合對齊本 spec。

4. **Success metric（人工；零容忍）**
   - 在 OpenAI 官網後台（人工查看）觀察第三方判定比例；**連續兩次觀察皆 = 0%** 才視為通過。
   - Phase 1+3 後殘留 > 0% → 不 finalize，繼續 Phase 2+4。
   - Phase 1+3+2+4 全做完仍 > 0% → 另開 follow-up spec 處理 TLS/JA3 / Cloudflare cookie 層。
   - Phase 2+4 仍保留 acceptance 1+2+3（單元/建置/整合測試）作為回歸檢查；first-party 比例是本 spec 的 gating metric。

5. **Regression check**
   - 既有 WS HTTP fallback 切換行為不變。
   - 既有 account switching、turnState 傳遞、continuation 邏輯不回歸。
