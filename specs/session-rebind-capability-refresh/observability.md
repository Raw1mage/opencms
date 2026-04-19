# Observability: session-rebind-capability-refresh

Events / metrics / logs / alerts introduced by this spec. Dashboard 整合點。

## Log Lines

All logs use `service: "rebind-epoch"` 或 `"capability-layer"` 作為 Log.create 的 service 標籤（prefix 隨 service 自動帶入）。

| Level | Service | Message | Payload |
|---|---|---|---|
| `info` | `rebind-epoch` | `[rebind-epoch] bumped` | `{ sessionID, trigger, previousEpoch, currentEpoch, reason? }` |
| `info` | `rebind-epoch` | `[rebind-epoch] lazy init` | `{ sessionID, trigger: "daemon_start" }` — 第一次 bump |
| `warn` | `rebind-epoch` | `[rebind-epoch] rate limit exceeded` | `{ sessionID, trigger, windowMs, maxPerWindow, observedCount }` |
| `info` | `capability-layer` | `[capability-layer] cache hit` | `{ sessionID, epoch }` (debug 等級可選) |
| `info` | `capability-layer` | `[capability-layer] reinject started` | `{ sessionID, epoch, trigger }` |
| `info` | `capability-layer` | `[capability-layer] reinject done` | `{ sessionID, epoch, layers, pinnedSkills, missingSkills, durationMs }` |
| `error` | `capability-layer` | `[capability-layer] reinject failed` | `{ sessionID, epoch, failingLayer, error, keptPreviousCache: true }` |
| `info` | `capability-layer` | `[capability-layer] fallback to previous epoch cache` | `{ sessionID, currentEpoch, fallbackEpoch }` — 前一個 epoch cache 被用來 cover 當前 miss |
| `info` | `reload` | `[reload] slash command` | `{ sessionID, previousEpoch, currentEpoch }` |
| `info` | `refresh-capability-tool` | `[refresh-capability-tool] invoked` | `{ sessionID, reason, turnCount, previousEpoch, currentEpoch }` |
| `warn` | `refresh-capability-tool` | `[refresh-capability-tool] per-turn limit hit` | `{ sessionID, turnCount, perTurnLimit }` |
| `info` | `session-route` | `[session-route] resume signal` | `{ sessionID, origin, sessionStatus, action: "silent_reinject" \| "skip_busy" }` |
| `warn` | `session-route` | `[session-route] forbidden origin` | `{ sessionID, origin }` |

## Events

Runtime events appended to `RuntimeEventService`. Consumed by dashboard + session detail drawer.

### session.rebind

- **Level**: `info` | **Domain**: `workflow` | **Anomaly flags**: `[]`
- **Trigger**: 每次 `RebindEpoch.bumpEpoch` 成功 bump
- **Payload**: `{ trigger: RebindTrigger, previousEpoch, currentEpoch, reason?: string }`
- **Dashboard use**: session detail drawer 的「Rebind History」時間軸顯示

### capability_layer.refreshed

- **Level**: `info` | **Domain**: `workflow` | **Anomaly flags**: `[]`
- **Trigger**: `CapabilityLayer.reinject` 成功填入 cache
- **Payload**: `{ epoch, layers: CapabilityLayerName[], pinnedSkills: string[], missingSkills?: string[] }`
- **Dashboard use**: 「已載技能」面板即時更新 pinned skill 卡片

### session.rebind_storm

- **Level**: `warn` | **Domain**: `anomaly` | **Anomaly flags**: `["rebind_storm"]`
- **Trigger**: 1 秒內第 6 次 bumpEpoch 被 rate-limit 拒絕
- **Payload**: `{ trigger, windowMs: 1000, maxPerWindow: 5, observedCount: 6+ }`
- **Dashboard use**: 紅點警示 + 彈窗「Session S 有 rebind storm 跡象，可能有 UI bug 或 tool loop」

### capability_layer.refresh_failed

- **Level**: `error` | **Domain**: `anomaly` | **Anomaly flags**: `["capability_layer_refresh_failed"]`
- **Trigger**: reinject 某 layer 讀檔 throw exception
- **Payload**: `{ epoch, failingLayer: CapabilityLayerName, error: string, keptPreviousCache: boolean }`
- **Dashboard use**: 檢查 icon + session detail drawer 顯示失敗 layer 名；R3 mitigation 下 session 不炸

### tool.refresh_loop_suspected

- **Level**: `warn` | **Domain**: `anomaly` | **Anomaly flags**: `["refresh_loop_suspected"]`
- **Trigger**: 同 assistant turn 第 4 次 `refresh_capability_layer` 被擋
- **Payload**: `{ turnCount, perTurnLimit: 3 }`
- **Dashboard use**: session detail 顯示該 turn 有 AI 異常行為

### session.resume_forbidden_origin

- **Level**: `warn` | **Domain**: `anomaly` | **Anomaly flags**: `["resume_forbidden_origin"]`
- **Trigger**: `POST /session/:id/resume` 來源非 Unix socket
- **Payload**: `{ origin: string }`
- **Dashboard use**: security audit log；提醒 operator 檢查是否有外部服務嘗試注入 signal

### skill.mandatory_missing（既有事件，沿用）

- 當 `CapabilityLayer.reinject` 發現某 mandatory skill 的 SKILL.md 缺失時，仍沿用 mandatory-skills-preload spec 既有事件
- **Anomaly flags**: `["mandatory_skill_missing"]`
- **Payload**: `{ skill, source, searchedPaths }`

## Metrics

若 metrics infrastructure 建立：

- `rebind_events_total{sessionID, trigger}` — counter per session per trigger
- `capability_layer_reinject_duration_ms{layer}` — histogram；預期 p95 < 20ms
- `capability_layer_cache_hit_ratio` — target > 90%（大部分 round 該 cache hit）
- `rebind_storm_total` — counter；baseline 應該接近 0
- `refresh_loop_suspected_total` — counter；baseline 應該接近 0

## Dashboard 整合

### 「已載技能」面板

- 訂閱 `capability_layer.refreshed` SSE stream
- Payload 的 `pinnedSkills` 直接對應到 skill 卡片清單
- Payload 的 `missingSkills` 顯示紅點 + 「N skills missing」提示
- Payload 的 `epoch` 顯示為小字標籤 `epoch: N`（debug 用）

### Session detail drawer（新增 section）

- **Rebind History**：時間軸顯示最近 N 次 `session.rebind` 事件
  - 每行：時間 / trigger / previousEpoch → currentEpoch / reason
  - 可以 filter by trigger 類型
- **Capability Layer Status**：顯示當前 epoch + 最後一次 reinject 時間 + 當前 pinned skills
- **Anomaly indicators**：紅點聚合 rebind_storm / refresh_failed / refresh_loop_suspected 計數

### Toast 通知

- `/reload` 完成 → toast「Capability layer refreshed (N → N+1)」
- `refresh_capability_layer` tool 完成 → 同樣 toast，但標示 trigger="AI"
- `rebind_storm` 發生 → toast warn + 連結到 session detail

## Alerts (operator-facing, Phase 2)

目前不定義 paging alert。候選：

- 全 daemon `rebind_storm_total` 一小時 > 10 次 → 可能代碼 bug
- 單 session `capability_layer.refresh_failed` 連續 3 次 → skill library 或 AGENTS.md 檔案可能損壞
- `capability_layer_reinject_duration_ms{layer}` p95 > 100ms → 磁碟 I/O 異常

## Log Correlation

所有本 spec 的 log / event 都帶 `sessionID` 欄位，可 cross-reference 到：

- `runtime-event-service` 既有 domain `workflow` / `anomaly` / `session_status`
- `session-status` busy/retry transitions
- `skill-layer-registry` entry state changes（既有 log）
- `prompt.ts` runLoop debug checkpoints

## Debug Toggle

- `Log.create({ service: "rebind-epoch" })` / `"capability-layer"` 預設 INFO level；需要更詳細可在 daemon 啟動時 `--log-level=debug`
- `DEBUG=*` 環境變數啟用 debug 等級（含 cache-hit 細節）

## Sampling / Retention

- Logs：標準 daemon logging；無 sampling
- Events：沿用 `RuntimeEventService` 既有 per-session 保留策略（滾動式）
