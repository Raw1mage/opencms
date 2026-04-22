# Observability: frontend-session-lazyload

## Events

結構化事件（schema 對應 `data-schema.json` → `LazyloadTelemetryEvent`），發到 client 的 telemetry sink（與 session-reload-debug beacon 共用 pipeline）。

| Event name | 何時發 | Payload 關鍵欄位 | 用途 |
|---|---|---|---|
| `lazyload.meta.call` | `openRootSession` 呼 meta 前 | `sessionID` | 量測呼叫頻率 |
| `lazyload.meta.fail` | meta 呼叫失敗 | `sessionID`, `details.status` | 量測 fail rate |
| `lazyload.threshold.exceeded` | meta 回傳超過門檻 | `sessionID`, `partCount`, `totalBytes` | 量測大 session 發生頻率 / 哪些 session 撞到 |
| `lazyload.loadmore.trigger` | scroll-spy 觸發 loadMore | `sessionID`, `details.currentLimit` | 量測被動載入實際觸發頻率（vs 手動按鈕） |
| `lazyload.loadmore.complete` | loadMore 完成 | `sessionID`, `details.newCount`, `details.durationMs` | 量測載入延遲 |
| `lazyload.part.fold` | MessagePart 套 fold UI | `partID`, `details.textLength` | 量測 fold 觸發分布 |
| `lazyload.part.expand` | 使用者點展開 | `partID` | 量測 fold UX 是否反感 |
| `lazyload.streaming.tail` | 進入 tail-window（含截斷 partId） | `partID`, `details.truncatedPrefix`, `details.keptKB` | 量測 rebuild storm 影響面 |
| `lazyload.rebuild.detected` | R4 heuristic 判為 rebuild | `partID`, `details.deltaChars` | 驗證 heuristic 正確性 |
| `lazyload.rebuild.mismatch` | R4 heuristic 前綴不 match | `partID`, `details.existingLen`, `details.incomingLen` | 警戒 AI SDK 行為變化 |
| `lazyload.flag.state` | app 啟動時記錄 flag 值 | `flag` | 區分 rollout 期 on/off 帳號 |
| `sse.replay.handshake` | SSE reconnect handshake 完成時 (R8, ADDED 2026-04-22) | `lastId`, `returned`, `dropped`, `boundary` (count/age/none) | 量測 bounded replay 的 drop 率 |
| `sse.replay.sync_required` | handshake 判定要發 sync.required (R8) | `lastId`, `reason` (count-exceeded/age-exceeded/buffer-overflow) | 監控 sync.required 頻率是否過高 |
| `messages.cursor.fetch` | `GET /:id/message` 回應時 (R9, ADDED 2026-04-22) | `sessionID`, `before` (messageID or null), `limit`, `returned` | 量測 cursor 分頁實際使用 |
| `messages.cursor.exhausted` | server 回空 page 時 (R9) | `sessionID`, `lastKnown` | 驗證前端正確標 `history.complete` |

## Metrics

### webapp (client-side)

- `lazyload_meta_duration_ms` — histogram（meta call p50/p95/p99）
- `lazyload_meta_fail_rate` — counter / minute
- `lazyload_threshold_exceeded_count` — counter per session
- `lazyload_loadmore_triggered_total` — 分「auto (scroll-spy)」/「manual (button)」兩 label
- `lazyload_loadmore_duration_ms` — histogram
- `lazyload_part_fold_ratio` — `part.fold` / 總 `part render` 次數
- `lazyload_rebuild_mismatch_ratio` — `rebuild.mismatch` / (`rebuild.detected` + `rebuild.mismatch`)；大於 10% 需警戒

### server (daemon)

- `session_meta_cache_hit_ratio` — `hit / (hit + miss)`
- `session_meta_304_ratio` — 304 回傳佔 meta 請求比例
- `session_meta_compute_duration_ms` — cache miss 時計算 partCount / totalBytes 的耗時
- `sse_replay_returned` — histogram per handshake (R8, ADDED 2026-04-22)
- `sse_replay_dropped` — histogram per handshake (R8)
- `sse_replay_sync_required_rate` — `sync_required / handshake` 比率（>10% 要告警）
- `messages_cursor_returned` — histogram per `GET /:id/message` (R9)
- `messages_cursor_full_tail_rate` — 無 `beforeMessageID` 的呼叫比率（應該接近 1.0，因為大多是 cold open）

### browser heap（比對用，非本 plan 發出，但驗收要量）

- `performance.memory.usedJSHeapSize`（Chromium only）
- DELTA-PART log 數量 / 秒（daemon log）

## Logs

### Client 端

- `[lazyload]` prefix 統一，等級 `info` / `warn` / `error`
- Error 級別事件同時發到 UI（toast / banner）
- Warn 級別每 session 每 key 限發一次（避免洗 console）

### Server 端

- `[lazyload-meta]` prefix for meta endpoint
- `[lazyload-cache]` for cache hit / miss / invalidation events（共用既有 SessionCache log 格式）
- `[SSE-REPLAY]` prefix，每次 SSE handshake 一行：`lastId=X returned=N dropped=M boundary={count|age|none}` (R8, ADDED 2026-04-22)
- `[MESSAGES-CURSOR]` prefix，每次 `/:id/message` 一行：`sessionID=X before=<id|null> limit=N returned=M` (R9)

## Alerts

Rollout 期（§7.6）與長期維護期的告警門檻：

| Alert | 條件 | 動作 |
|---|---|---|
| **`LAZYLOAD_META_FAIL_SPIKE`** | `lazyload.meta.fail` / `lazyload.meta.call` 任一小時 > 5% | 通知 on-call；檢查 daemon log；必要時 tweaks.cfg flag=0 回退 |
| **`REBUILD_HEURISTIC_DEGRADED`** | `lazyload_rebuild_mismatch_ratio` 24hr 平均 > 10% | 通知 dev；檢查 AI SDK 最新版本變更，重評 DD-5 |
| **`LAZYLOAD_MEMORY_REGRESSION`** | Load test fixture flag=1 的 heap peak > flag=0 的 80% | block merge |
| **`LAZYLOAD_FLAG_READ_FAIL`** | `LAZYLOAD_FLAG_UNAVAILABLE` 出現於正式使用者環境 | 通知 dev 檢查 tweaks.cfg 部署 |
| **`SSE_REPLAY_SYNC_REQUIRED_SPIKE`** (R8) | `sse_replay_sync_required_rate` 1 小時 > 10% | 檢查 `max_events` / `max_age_sec` 是否設太嚴；反查使用者是否長時間離線後重連（true positive） |
| **`MESSAGES_CURSOR_FULL_TAIL_ANOMALY`** (R9) | `messages_cursor_full_tail_rate` 1 小時 < 0.8 | 前端 `history.loadMore` 走錯 path（應該要用 cursor 而不是無 cursor）；追前端 bug |

## 量測腳本

`packages/app/test/fixtures/large-session-generator.ts` 產生 fixture；`scripts/lazyload-loadtest.sh` 跑 flag on/off 對照。輸出到 `docs/events/event_2026-04-20_frontend-lazyload.md` 的「Validation」段。
