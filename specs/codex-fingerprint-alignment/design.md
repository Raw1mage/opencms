# Design: codex-fingerprint-alignment

## Context

opencode-codex-provider 有兩條出站傳輸路徑：**WS**（`transport-ws.ts`，優先嘗試）與 **HTTP SSE**（`provider.ts`，fallback）。兩者各自組 header：HTTP 走 `buildHeaders()` 共用函式，WS 在 `transport-ws.ts:460-466` 內嵌 inline 建構。兩條路徑在 `User-Agent` 與 `ChatGPT-Account-Id` header 上出現漂移 — 正好命中 OpenAI 第一方分類器的降級條件。

upstream `refs/codex`（目前 `d0eff70383`，落後 268 commits）對應的 first-party 規格可在 `refs/codex/codex-rs/core/src/client.rs` 與 `refs/codex/codex-rs/login/src/auth/default_client.rs` 查到：UA、originator、ChatGPT-Account-Id、x-client-request-id、Accept 是 WS/HTTP 共用的必送 header。

## Goals / Non-Goals

### Goals

1. **立即止血** — WS 路徑補齊 UA 與 TitleCase account-id，讓 ~7% 第三方判定比例在最短時間內壓下去。
2. **跟上 upstream** — 將 submodule 對齊 `rust-v0.125.0-alpha.1`，更新 `CODEX_CLI_VERSION`，消除版本過舊造成的查表扣分。
3. **結構性收斂** — 兩條 transport 共用唯一 header builder，消除雙路徑漂移風險。
4. **補齊 fingerprint 細節** — 加上 `x-client-request-id` 與顯式 `Accept`，完成對齊。

### Non-Goals

- 不追 TLS/JA3 fingerprint（若 Phase 1+3 未達標再另開 spec）。
- 不做 fingerprint 自動化回歸（列為 follow-up 候選，不在本 spec 範圍）。
- 不動 OAuth / rotation / 其他 provider。

## Decisions

- **DD-1** — Phase 1 先以 inline 補 header（不等 Phase 2 重構），把 WS `User-Agent` 與 TitleCase `ChatGPT-Account-Id` 補上；Phase 2 再統一走 `buildHeaders()`。
  - Why：Phase 1 是止血動作，優先降風險；重構併進來會拉長 review 與驗證週期，與使用者「1、3 先」的意圖相違。
  - Trade-off：短期內 `transport-ws.ts` 與 `headers.ts` 會短暫各有一份 UA/account-id 邏輯；Phase 2 落地後消除。

- **DD-2** — WS 升級 header 的 `ChatGPT-Account-Id` 採 TitleCase，不使用 lowercase。
  - Why：upstream `client.rs` 用 TitleCase；HTTP/1.1 header 雖大小寫不敏感，但第一方分類器若做字面比對會視為 fingerprint 失配。HTTP/2 自動小寫化是底層傳輸，對應 server classifier 看到的是還原前的 name；保守策略是對齊 upstream 原文。

- **DD-3** — Phase 3 鎖定 `rust-v0.125.0-alpha.1` tag，不追 rolling HEAD。
  - Why：tag 是 upstream 宣告的 release point；雖為 alpha，`main` 已指向此附近 commit（`a9c111da5` 為 `rust-v0.125.0-alpha.1~5`），選用已打 tag 的 `rust-v0.125.0-alpha.1` 取代散 commit，使 submodule 指向語意明確且可復現的 ref。
  - How：`git -C refs/codex fetch --tags && git -C refs/codex checkout rust-v0.125.0-alpha.1`，再在 main repo commit submodule pointer。
  - Trade-off：alpha 比 stable tag 不穩定；但 main 已走到比 0.124.0 更晚的位置，退回 0.124.0 會失去已 bundle 的修正；以 alpha.1 作為本 spec 的基線合理。

- **DD-4** — `CODEX_CLI_VERSION` 值採用 upstream tag `rust-v0.125.0-alpha.1` 對應的語意版本字串。
  - Why：UA 必須可被 OpenAI 查表命中；hard-code 的版本字串是對 server side 版本表的唯一信號。
  - 若 upstream `workspace.package.version` 仍為 `0.0.0`（monorepo 常見），採用 `0.125.0-alpha.1` 作為字面值（若 OpenAI 表格不接受 pre-release 字尾，可 fallback 到 `0.125.0`；Phase 3 執行時驗證並記錄）。

- **DD-5** — Phase 2 重構後，`buildHeaders()` 接受 `isWebSocket: boolean`，內部依此切換以下差異：
  - `isWebSocket=true` → 加上 `OpenAI-Beta: responses_websockets=<date>` header；可略過 `Content-Type`（WS 首訊息不是 HTTP body）。
  - `isWebSocket=false` → 加上 `Content-Type: application/json`、`Accept: text/event-stream`（Phase 4）。
  - Why：用單一函式覆蓋兩條路徑的共同欄位，transport-specific 欄位以 flag 分支；比「兩個獨立函式」更容易保證一致性。

- **DD-6** — `x-client-request-id` 值 = `conversationId`（與 upstream `client.rs` 行為一致）。
  - Why：upstream 直接用 conversation id；本 plugin 的 `window.conversationId` 正是對應概念，無需新增狀態。

- **DD-7** — 驗證先落在 beta worktree，確認有效後 fetch-back 回 main。
  - Why：第三方判定比例只能透過 OpenAI 官網後台人工查看；beta 隔離讓驗證期不影響 main 使用者。
  - How：依 `beta-workflow` skill 建 `implementationBranch`，完成 acceptance checks 後 fetch-back。

- **DD-8** — 與 `codex-prompt-rebuild-incremental`（尚未建立）的檔案衝突由「先完成 fingerprint spec、再啟動 prompt rebuild spec」避免。
  - Why：兩者共用 `transport-ws.ts` 但動不同函式；序列化執行比平行執行更安全（單變量驗證、避免 diff 交疊）。

## Risks / Trade-offs

- **R1** — Phase 1 補 UA 後，OpenAI 後端仍把請求判為第三方。
  - 機率：中；影響：中（意味 fingerprint 不只這兩點）。
  - 緩解：Phase 3（版本對齊）+ Phase 4（補 x-client-request-id / Accept）三條線疊加；若四 phase 都做完仍 > 1%，再評估 TLS/JA3 層。
  - 偵測：beta 驗證期人工查看後台比例。

- **R2** — `rust-v0.125.0-alpha.1` 引入與本 plugin 既有實作不相容的改動（例如新的 body 欄位）。
  - 機率：低-中；影響：中-高（可能要併 Phase 3 一起做 body 對齊）。
  - 緩解：Phase 3 執行前先跑 `git log rust-v0.122.0..rust-v0.125.0-alpha.1 -- codex-rs/core/src/client.rs codex-rs/login/src/auth/default_client.rs` 盤點 diff，若出現破壞性改動則升級為 `revise` 模式。

- **R3** — Phase 2 重構改壞現有 WS 成功路徑（93% 的流量）。
  - 機率：低；影響：高（會全面回歸）。
  - 緩解：Phase 2 在 beta 驗證；新增 `transport-ws.test.ts` 專門鎖定 header 集合；acceptance check regression 項目明示。

- **R4** — `CODEX_CLI_VERSION` 對應的 upstream 版號取不到（monorepo `0.0.0`）。
  - 機率：中；影響：低。
  - 緩解：DD-4 fallback 用 tag 本身的語意版本 `0.125.0-alpha.1`。

- **R5** — beta worktree 驗證期間，`~/.config/opencode/` 被測試寫亂。
  - 機率：中；影響：高（曾發生 codex-rotation-hotfix 測試抹掉 accounts）。
  - 緩解：開跑前執行 XDG 備份（依 project CLAUDE.md 規則）；beta worktree 用 `OPENCODE_DATA_HOME` 環境變數或獨立 uid 隔離。

## Critical Files

### 直接修改

- `packages/opencode-codex-provider/src/headers.ts` — `BuildHeadersOptions`、`buildHeaders` 實作（Phase 2 擴充 WS 分支、Phase 4 加欄位）。
- `packages/opencode-codex-provider/src/transport-ws.ts` — `connectWs` 呼叫站附近的 header 組裝（Phase 1 inline 補 UA + TitleCase；Phase 2 改為呼叫 `buildHeaders`）。
- `packages/opencode-codex-provider/src/protocol.ts` — `CODEX_CLI_VERSION` 常數（Phase 3）。
- `packages/opencode-codex-provider/src/provider.ts` — `buildHeaders()` 呼叫站可能增加 `conversationId` / `isWebSocket` 參數（Phase 4）。
- `refs/codex` — submodule pointer（Phase 3）。

### 測試

- `packages/opencode-codex-provider/src/headers.test.ts` — 新增 WS + account-id case-sensitivity + Phase 4 欄位。
- `packages/opencode-codex-provider/src/provider.test.ts` — HTTP path regression + Phase 4 Accept 斷言。
- `packages/opencode-codex-provider/src/transport-ws.test.ts`（新增，Phase 2） — WS header 集合 snapshot。

### 參考（不修改，對照用）

- `packages/opencode/src/plugin/codex-auth.ts:47-53` — `buildCodexUserAgent()` UA 來源。
- `refs/codex/codex-rs/core/src/client.rs` — upstream header 定義。
- `refs/codex/codex-rs/login/src/auth/default_client.rs` — upstream UA 組裝。

### 下游
- `docs/events/event_20260424_codex_session_cpu_burn.md` — CPU burn event；與 `codex-prompt-rebuild-incremental` 銜接的觸發點。
