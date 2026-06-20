# Observability: subagent_cwd_pathloss_hang

## Events

| Event | Source | Payload | Purpose |
|---|---|---|---|
| worker spawn cwd log | `session.ts:192` worker file logger | `cwd=<abs path>` | Fix A 驗證證據：確認 worker 啟動於 repo root 而非 `/` |
| subagent completion notice | orchestrator runtime | `status=no_progress_timeout` | Fix C 驗證：watchdog reap 後 orchestrator 可觀測 |
| paralysis nudge injection | `prompt.ts` detector | nudge text + detector tag | Fix C：runloop 脫離跳針的可觀測訊號 |

## Metrics

| Metric | 判定 | 閾值 |
|---|---|---|
| `consecutiveErrorOrIdentical` | proc-watchdog no-progress 累計 | M ≥ 5 → reap |
| `zeroMutationTurns` | paralysis detector tool-active 但零 mutation 輪數 | N ≥ 6 → trigger |
| worker `process.cwd()` | 應等於 `Instance.directory` | 不等 → path-loss bug 復發 |

## Logs

- worker file logger（`session.ts:192`）記錄 `cwd`，可作為 Fix A runtime 驗證的直接證據。
- proc-watchdog scan 記錄 no-progress 累計值與 reap 決策。
- paralysis detector 命中時記錄 detector 類別（與 Detector A–D 區分）。

## Alerts

- worker `process.cwd()` ≠ `Instance.directory` → path-loss 回歸，應 fail-loud 而非告警後續跑。
- `no_progress_timeout` 頻率異常升高 → 可能 driver prompt 或環境問題導致大量 subagent 跳針，需調查。

## Runtime Validation Evidence (this spec)

- live coding subagent `ses_11fc0f348ffe4PRdQRgMR2d7Sp`：`pwd`=`/home/pkcs12/projects/opencode`，context 含 `Working directory (workspace root): /home/pkcs12/projects/opencode`。
