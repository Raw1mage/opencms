# Phase 1 slice summary — codex-fingerprint-alignment

日期：2026-04-24
Spec：`specs/codex-fingerprint-alignment/` (state=implementing)
分支：`beta/codex-fingerprint-alignment` @ `e25f82f1a`

## Phase

1 — WS transport inline fingerprint hotfix

## Done

- **1.1** XDG 白名單備份（`~/.config/opencode.bak-20260424-2014-codex-fingerprint-alignment/`，10 檔 + `share/accounts.json`）
- **1.2** beta worktree checkout 新分支（從 main `6a98c6150` 分叉）
- **1.3** `transport-ws.ts` 補 `User-Agent`（透過 `options.userAgent` 注入；由 provider.ts 傳遞 `buildCodexUserAgent()` 結果）
- **1.4** `chatgpt-account-id`（lowercase）→ `ChatGPT-Account-Id`（TitleCase）
- **1.5** 新增 `transport-ws.test.ts`（7 cases）；export helper `buildWsUpgradeHeaders` 為 Phase 2 整併預留 seam
- **1.6** `bun test packages/opencode-codex-provider`：43 pass / 0 fail / 97 expect
- **1.7** 原規劃 "beta daemon 啟動抓 log"，改採 fetch-back 策略 — unit test 已鎖住 header 邏輯，真流量 first-party 比例只能靠 OpenAI 官網後台手動觀察（§3 beta soak 處理）

## Key Decisions (from design.md)

- **DD-1** — inline 補 header（非等 Phase 2 重構完）
- **DD-2** — TitleCase `ChatGPT-Account-Id`，對齊 upstream `refs/codex/codex-rs/core/src/client.rs`

## Validation

- Unit：43/43 passing（含 7 個新 WS case 鎖定 fingerprint 契約）
- Build：（fetch-back 階段跑 — 見下一則 event log）

## Drift

- `plan-sync.ts` 本次未執行（Phase 1 新增檔案 + 修改檔案都對齊 spec `What Changes` 區塊，無 drift 預期）

## Remaining for next phase

- Phase 3 submodule 同步（主 repo 已預先把 `refs/codex` pin 到 `rust-v0.125.0-alpha.1` via commit `57cde900a`，剩 `CODEX_CLI_VERSION` 常數更新 + upstream diff 盤點）
- §3 beta soak + 手動查 OpenAI 官網後台 first-party 比例

## Commits

- `e25f82f1a` on `beta/codex-fingerprint-alignment`：`fix(codex-provider): add User-Agent + TitleCase ChatGPT-Account-Id to WS upgrade`

## Follow-ups

- Phase 2 合併 `buildWsUpgradeHeaders` → `buildHeaders({ isWebSocket: true })`
- Phase 4 加 `x-client-request-id` / `Accept` header
