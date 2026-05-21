# Event — Restart Closure Marker

## 需求

使用者確認昨日 `self 3r` 後兩次 rebuild/restart 已成功，但 `restart-handover/pending.json` 與 checkpoint 仍停在 `restart-requested`，要求本次修好後執行一次 `self 3r`。

## 範圍(IN/OUT)

### In

- 修復 daemon startup 成功後未閉合 restart handover marker 的狀態紀錄問題。
- 保留既有 fail-fast restart 行為，不改 daemon/gateway lifecycle 權威。
- 修好後執行一次 `restart_self` 三階段驗證（self 3r）。

### Out

- 不新增 fallback restart path。
- 不用 Bash spawn/kill/restart daemon 或 gateway。
- 不處理與 restart closure 無關的既有工作樹變更。

## 任務清單

- [x] 讀取架構與 restart handover/startup log 邊界。
- [x] 建立 XDG 白名單備份。
- [x] 讓成功 daemon startup 原子更新 checkpoint 與 pending 狀態。
- [x] 補/跑 focused tests。
- [x] 執行一次 `system-manager_restart_self` 並檢查 error log/startup evidence/pending closure。

## Debug Checkpoints

- Evidence: `mcp-web-1779297081224-2824779` 與 `mcp-web-1779305688163-3484732` 的 error log 皆為 `[EXIT] 0`，且 `daemon-startup/startup.jsonl` 有相同 txid 的 `daemon-started` 紀錄。
- Symptom: 最新 `restart-handover/pending.json` 仍停在 `status: restart-requested`，checkpoint 本體也沒有成功閉合欄位。
- Boundary: `DaemonStartupLog.record()` 只 append startup jsonl，讀取 pending txid 但不更新 `restart-handover/<txid>.json` 或 `pending.json`。
- First runtime smoke: `mcp-web-1779343728379-4035894` failed before daemon respawn. Error log showed frontend build falling into opencode CLI help via `script/build.ts` Vite invocation, then `[EXIT] 1`; no matching startup record was written and pending remained `restart-requested`.
- Build boundary fix: `script/build.ts` now invokes the app-local Vite JS entry (`packages/app/node_modules/vite/bin/vite.js`) instead of the `.bin/vite` shim, avoiding Bun/compiled-binary CLI resolution ambiguity.
- Second runtime smoke: `mcp-web-1779343880466-4035894` still failed because child `Bun.spawn(["bun", ...])` resolved through the packaged opencode CLI environment during binary build. Fix tightened the argv to absolute `/home/pkcs12/.bun/bin/bun`.
- Successful runtime smoke: `mcp-web-1779344044087-4035894` error log ended `[EXIT] 0`; `daemon-startup/startup.jsonl` line 475 recorded the same txid after Unix socket bind; both `restart-handover/pending.json` and the checkpoint were updated to `restart-completed`.

## Root Cause

Restart handover 已具備「請求 marker」與「startup evidence」，但缺少 post-start closure writer。新 daemon 成功 bind 後只追加 startup log，沒有把 pending marker 轉成 completed 狀態，因此後續查詢會把已成功的 restart 誤判為仍在 pending。

## Validation

- `bun test --timeout 15000 packages/opencode/test/server/restart-handover.test.ts packages/opencode/test/server/daemon-startup-log.test.ts` passed: 4 tests, 23 assertions。
- `bun /home/pkcs12/projects/opencode/packages/app/node_modules/vite/bin/vite.js build` passed from `packages/app` cwd.
- `bun run script/build.ts --single --skip-install` passed through frontend and binary build.
- Runtime `self 3r` passed: txid `mcp-web-1779344044087-4035894`, `[EXIT] 0`, startup evidence present, pending/checkpoint status `restart-completed`.

## Architecture Sync

- Updated `specs/architecture.md` controlled self-restart boundary: daemon startup now appends startup evidence and atomically marks matching checkpoint/pending marker as `restart-completed`。

## Backup

- XDG whitelist backup: `/home/pkcs12/.config/opencode.bak-20260521-restart-closure`。
