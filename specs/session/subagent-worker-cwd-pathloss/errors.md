# Errors: subagent_cwd_pathloss_hang

## Error Catalogue

| Code | Trigger | User-visible message | Recovery | Layer |
|---|---|---|---|---|
| `WORKER_DIRECTORY_MISSING` | `spawnWorker()` 時 `capturedDirectory` (= `Instance.directory`) 為 undefined | "Cannot spawn subagent worker: Instance.directory is undefined (no silent fallback to `/`)" | 由上層補 `Instance.provide` 後重試 dispatch；禁止 silent fallback（AGENTS rule 11） | `task.ts` spawnWorker (DD-1) |
| `no_progress_timeout` | proc-watchdog 偵測連續 M (≥5) 次 tool-error / identical-signature output | （內部 finish reason，呈現為 subagent completion notice status=no_progress_timeout） | orchestrator 收到 notice → 評估是否換 account / replan / 重派 | `task.ts` proc-watchdog (DD-4) |
| `NO_PROGRESS_PARALYSIS` (nudge) | paralysis detector 偵測 ≥N (≥6) 輪 tool-active 但零 mutation + repeated error/identical-result | （注入 runloop 的 nudge 文案，非硬性 error） | worker 自我脫離跳針；若持續則由 watchdog reap | `prompt.ts` detector (DD-5) |

## Recovery Strategy Notes

- `WORKER_DIRECTORY_MISSING` 為 **fail-loud** 設計，刻意不自動恢復——避免 worker 在錯誤 cwd 啟動踩 path-loss。
- `no_progress_timeout` reap 後，worker 的 partial work 仍可由 orchestrator 透過 `read_subsession` 讀取評估。
- detector nudge 與 watchdog reap 為「先觸發者勝」（DD-6），不互相依賴。
