# Proposal: codex-fingerprint-alignment

## Why

- 約 7% 的 codex provider plugin 流量被 OpenAI 第一方分類器判定為第三方請求。降級後的請求走更嚴的限流、更低的配額，並可能被提早中斷，直接影響使用者體驗與帳號可用度。
- 根因分析顯示差異來自 request fingerprint 不一致，尤其是 WebSocket 交握階段缺 `User-Agent` 及 `ChatGPT-Account-Id` header 大小寫錯位；這兩點正是 OpenAI 分類器最常見的降級條件。
- plugin 內註解（codex-auth.ts:42-45）已自行記載：UA prefix 若與 `originator` 不匹配就會被降級 — 顯示開發者早已知此機制，但 WS 路徑未套用 `buildHeaders()` 共用邏輯，漏掉 UA。
- 次要因素：`CODEX_CLI_VERSION` 硬編碼 `0.122.0`，upstream 已到 `rust-v0.125.0-alpha.1`（submodule 落後 268 commits），版本過舊在第一方分類器查表時會被扣分。

## Original Requirement Wording (Baseline)

- "看一下refs的codex submoudule有沒有更新。我們的codex provider plugin有7%流量被判定為第三方。查一下request fingerprint是哪裏不一致"
- "寫成spec。1，3先，再2，4"
  - 對應本 spec 的 Phase 1 / Phase 3 優先；Phase 2 / Phase 4 次之。

## Requirement Revision History

- 2026-04-24: initial draft created via plan-init.ts
- 2026-04-24: 使用者指定四階段優先序 — Phase 1（WS fingerprint hotfix）+ Phase 3（upstream 同步）先行；Phase 2（header builder 重構）+ Phase 4（補齊 x-client-request-id / Accept）隨後。
- 2026-04-24: 釐清四個開放問題 —
  1. Upstream 目標鎖定 tag `rust-v0.125.0-alpha.1`（不追 rolling HEAD）。
  2. 驗證方式：先在 beta worktree 隔離驗證，確認有效後再 fetch-back 回 main。
  3. 成功指標資料來源：OpenAI 官網後台（只能手動查看），沒有自動化統計；驗收時需人工對照 before/after。
  4. Phase 4 範圍鎖定「只補 `x-client-request-id` + `Accept: text/event-stream`」，不擴充到其他 conditional header。

## Effective Requirement Description

1. **Phase 1（優先）— WS transport fingerprint 對齊 upstream**
   - 在 `transport-ws.ts` 的 WebSocket 升級 header 中補上 `User-Agent`（格式須與 HTTP 路徑一致：`codex_cli_rs/<ver> (<OS> <release>; <arch>) terminal`）。
   - 將 `chatgpt-account-id` 改為 upstream 使用的 TitleCase `ChatGPT-Account-Id`。
2. **Phase 3（優先）— 同步 upstream codex 並更新版本常數**
   - 將 `refs/codex` submodule 從 `d0eff70383` 更新到 tag `rust-v0.125.0-alpha.1`（固定鎖版，不追 rolling HEAD）。
   - 更新 `packages/opencode-codex-provider/src/protocol.ts` 中的 `CODEX_CLI_VERSION` 常數，使其與 submodule 對齊。
   - 檢查同步後 upstream 是否新增 / 改動任何 header / body 欄位；若有，記入本 spec 的 follow-up。
3. **Phase 2（後續）— 統一 header 建構路徑**
   - 重構 `transport-ws.ts:460-466` 內嵌的 header 建構，改為呼叫 `buildHeaders({ ..., isWebSocket: true })`。
   - 讓 `buildHeaders` 是唯一的 codex request header 入口，消除雙路徑漂移。
4. **Phase 4（後續）— 補齊剩餘 fingerprint 欄位**
   - 加上 `x-client-request-id` header（值 = `conversation_id`，與 upstream 行為一致）。
   - HTTP 路徑顯式設定 `Accept: text/event-stream`（目前仰賴 fetch 預設值，與 upstream `.header("accept", "text/event-stream")` 不同）。

## Scope

### IN
- `packages/opencode-codex-provider/src/` 下的 header 建構、WS transport、版本常數。
- `packages/opencode/src/plugin/codex-auth.ts` 的 `buildCodexUserAgent()` 驗證（只確認其輸出被兩個 transport 共用，不改格式）。
- `refs/codex` submodule pointer 升級，及隨之而來的 upstream header 差異盤點。
- `specs/codex-fingerprint-alignment/` 內所有 artifact。

### OUT
- OpenAI endpoint URL 變更（已確認上游維持 `/backend-api/codex/responses`，本次不動）。
- TLS 層 / JA3 fingerprint 對齊（若 Phase 1+3 未將 7% 降至接近 0%，再另開 spec 處理）。
- OAuth flow、token refresh、帳號輪替（rotation3d）邏輯 — 屬另一工作線。
- 其他 provider（gemini-cli、google-api、anthropic 等）的 fingerprint — 不在本 spec 範圍。

## Non-Goals

- 不嘗試 100% 二進位等價於 upstream rust client 的 request bytes — 目標是讓 OpenAI 第一方分類器將本 plugin 視為 first-party。
- 不建立 fingerprint 回歸測試自動化（僅列為 Phase 4 後續 follow-up 的候選）。
- 不自動化「第三方判定比例」的採集 — 資料來源僅限 OpenAI 官網後台人工查看；本 spec 不處理採集管線。

## Success Criteria

- **主指標**：驗證期內 OpenAI 官網後台顯示的第三方判定比例從基線 ~7% 降至接近 0%（人工查看；至少在 beta 驗證期連續兩次觀察皆符合）。
- **驗證流程**：變更先落在 beta worktree / branch，跑至少一輪真實對話負載，手動比對後台 before/after；確認有效後再 fetch-back 回 main。
- **回歸基準**：既有 WS / HTTP 成功路徑（目前 ~93% 被視為 first-party）不因本次變更而下降。

## Constraints

- **不可直接 merge upstream**：依 `AGENTS.md` 的「外部 Plugin 管理」條款，`refs/codex` 的更新只能透過分析後在 main 中重構，不得直接 merge。
- **無聲 fallback 禁令**：若同步後發現 upstream 新增必要 header，plugin 必須顯式實作，不可忽略或靜默略過。
- **XDG 備份政策**：Phase 3 動到 submodule 與 plugin 原始碼，執行前需完整備份 `~/.config/opencode/` 至 timestamped 快照。
- **Daemon 生命週期**：任何需要驗證改動的 daemon 重啟必須透過 `system-manager:restart_self` MCP tool，不得自行 `kill` / `spawn`。
- **向後相容**：WS 與 HTTP 現有成功路徑（93% 正確分類）不得因本次變更而回歸。
- **與 `codex-prompt-rebuild-incremental` 的執行順序協調**：本 spec 的四個 phase 應**先於**未來 `/specs/codex-prompt-rebuild-incremental/` 的任何實作落地（該 spec 由 2026-04-24 `event_20260424_codex_session_cpu_burn.md` 催生，處理 WS REQ 的 prompt O(N) rebuild）。兩者共用 `packages/opencode-codex-provider/src/transport-ws.ts` 但動不同函式（本 spec 改 header 組裝；另一個改 body/prompt 組裝）。先做 fingerprint、再做 prompt rebuild 的原因：(1) 面積窄、風險低先落；(2) 兩 spec 分別綁 beta 驗證，才能獨立確認 7% 是哪個 fix 壓下去的；(3) 避免同檔 diff 交疊造成 merge 噪音。

## What Changes

- `packages/opencode-codex-provider/src/transport-ws.ts` — WS header 組裝（Phase 1 hotfix，Phase 2 重構至呼叫 `buildHeaders`）。
- `packages/opencode-codex-provider/src/headers.ts` — 若 Phase 4 新增欄位，擴充 `BuildHeadersOptions` 與 `buildHeaders` 實作。
- `packages/opencode-codex-provider/src/protocol.ts` — `CODEX_CLI_VERSION` 常數升級（Phase 3）。
- `refs/codex` — submodule pointer 升級（Phase 3）。
- `packages/opencode-codex-provider/src/provider.ts` — 若 Phase 4 需新增 Accept header 或 x-client-request-id 參數傳遞，會順勢調整 `buildHeaders` 的呼叫站。
- 對應 test 檔（`headers.test.ts` / `provider.test.ts` / WS transport 測試若有）— 覆蓋新欄位。

## Capabilities

### New Capabilities
- **WS transport first-party fingerprint**：WebSocket 升級請求擁有與 HTTP 路徑一致的 first-party header 組合，被 OpenAI 分類器識別為 first-party codex client。
- **Header builder single entry point**（Phase 2 後）：所有 codex 出站 HTTP/WS 請求的 header 皆由 `buildHeaders()` 產生，不再有第二組內嵌建構。

### Modified Capabilities
- **codex request emission**：現有 WS / HTTP 請求發送流程的 header 集合對齊 upstream `rust-v0.125.0-alpha.1`；body 結構與 endpoint 不動。
- **upstream tracking**：`refs/codex` 同步後，未來升級流程有明確的 checklist（header diff 盤點）。

## Impact

- **使用者端**：預期 OpenAI 第三方判定比例由 ~7% 降至 < 1%；對應降低配額降級、限流、請求中斷機率。
- **Plugin 維護者**：WS / HTTP 兩條路徑 header 來源統一，後續新增欄位只需改一處；減少雙路徑漂移風險。
- **Upstream drift**：Phase 3 完成後，`refs/codex` 與 `CODEX_CLI_VERSION` 對齊；建議納入日後例行 upstream 同步 cadence。
- **測試**：新增 WS header 測試；既有 HTTP header 測試需 regression check 確認大小寫與新欄位。
- **文件**：`specs/architecture.md` 若有提及 codex provider 結構，需同步更新；`docs/events/` 新增一則變更記錄。
- **下游 spec（尚未建立）**：`/specs/codex-prompt-rebuild-incremental/` 會在本 spec 完成驗證後銜接，處理同檔 `transport-ws.ts` 的 prompt rebuild 熱點。參見 `docs/events/event_20260424_codex_session_cpu_burn.md`。
