# Observability: session-ui-freshness

本 plan 的可觀測面向——events / metrics / logs / alerts。所有欄位命名採
snake_case；event 名採 `freshness.*` 前綴，metric 採 `client.freshness.*`。

---

## Events

純 client-side（不寫進 server event log；若未來要收集 telemetry，另開 backend
event 收集 endpoint，不走現有 SSE）：

| Event | When | Payload |
|---|---|---|
| `freshness.entry_stale` | freshness memo 在某 entry 首次跨過 soft threshold | `{entryKind: 'session_status'\|'active_child'\|'session_monitor', entryId, receivedAt, sinceReceivedMs}` |
| `freshness.entry_hard_stale` | freshness memo 在某 entry 首次跨過 hard threshold | 同上 |
| `freshness.entry_recovered` | hard-stale 或 stale entry 因為 event 到達重回 fresh | 同上 + `{previousFidelity}` |
| `freshness.invalid_timestamp` | DD-4 觸發（receivedAt undefined/NaN/Infinity） | `{entryKind, entryId, rawValue}` |
| `freshness.tweaks_loaded` | bootstrap 拉完 /config/tweaks/frontend | `{enabled, softSec, hardSec, source: 'server'\|'default'}` |
| `freshness.clock_jump` | `useFreshnessClock` 偵測到 `Date.now()` 跳動 > 10min | `{deltaMs, direction: 'forward'\|'backward'}` |

收集面：目前 client event 只進 `console.debug`（開發觀察用）；如果使用者同意
telemetry endpoint 再開 `POST /telemetry/client-events`（out of scope）。

---

## Metrics

| Metric | Type | Dimensions | Collected By | Purpose |
|---|---|---|---|---|
| `client.freshness.stale_entries` | gauge | session id, entryKind | Client per session tick | 當下該 session 有多少 entry 處 stale |
| `client.freshness.hard_stale_entries` | gauge | session id, entryKind | Client per session tick | 同上 for hard-stale |
| `client.freshness.invalid_timestamp_count` | counter | entryKind | Client 當 DD-4 路徑觸發 | 偵測 reducer bug 或型別漏洞；正常應為 0 |
| `client.freshness.flag_enabled` | gauge (0/1) | — | Client bootstrap | 看 rollout 比例（若未來接入 telemetry） |
| `client.freshness.memo_recalc_rate` | gauge (Hz) | component id | Dev-only (debug mode) | 觀察 DD-2 single-clock 設計是否真的單一 tick drive |
| `server.freshness.tweaks_served_count` | counter | enabled_value | `/config/tweaks/frontend` hit | 追蹤 flag 被多少 client 拉走 |

Metric 儲存 / 輸出面：Phase 1–5 不強制接入 Prometheus / OTel；先確保 `console.debug`
可觀測。正式 metric backend 由另一個 plan（observability infrastructure）處理。

---

## Logs

結構化 log format：`[freshness] <event-name> entry=<id> kind=<kind> ...`

| Log pattern | Level | Context |
|---|---|---|
| `[freshness] entry <id> stale (received=<ts>, now=<ts>, delta=<ms>ms, soft=<ms>ms)` | info | freshness.entry_stale event 的 narrative log |
| `[freshness] entry <id> hard-stale (delta=<ms>ms, hard=<ms>ms)` | info | freshness.entry_hard_stale event |
| `[freshness] entry <id> recovered (previous=<stale\|hard-stale>)` | info | freshness.entry_recovered |
| `[freshness] invalid receivedAt on entry <id>: raw=<value>` | warn | `FRESHNESS_INVALID_TIMESTAMP`（rate-limited ≤1/min/entry） |
| `[tweaks] freshness keys loaded: enabled=<0\|1> soft=<s>s hard=<s>s` | info | bootstrap |
| `[tweaks] freshness keys unavailable, using defaults` | warn | `FRESHNESS_TWEAKS_LOAD_FAILED` |
| `[tweaks] freshness keys clamped: soft=<raw>→<clamped>` | warn | `FRESHNESS_TWEAKS_OUT_OF_RANGE`（server 端） |
| `[freshness] clock jump detected: delta=<ms>ms direction=<...>` | info | diagnostic |
| `[DD-6 guard] residual connectionStatus reference detected at <file>:<line>` | error | `CONNECTION_STATUS_RESIDUAL`（CI log） |

Rate-limit 規則：warn-level 的 per-entry 訊息同一 entry 60 秒內只打一次
（用 module-level `Map<entryId, lastLoggedAt>` 做記憶）。

---

## Alerts

**不主動 page**；本 plan 不引入 on-call alert，但下列訊號是 incident 時的
第一線排查起點：

| Signal | 看板 | Threshold | 意義 |
|---|---|---|---|
| `client.freshness.invalid_timestamp_count > 0` 持續超過 5 分鐘 | dev console / future telemetry | 0 | reducer 寫入 bug 或 TypeScript 型別漏洞 |
| `client.freshness.hard_stale_entries / total_entries` 高峰 > 30% | grafana（未來） | 10% | server heartbeat 失靈或 SSE 通道斷線過久；不是本 plan 的 bug，但 UI 正確反映 |
| `CONNECTION_STATUS_RESIDUAL` CI build fail | GitHub Actions | 0 | 本 plan 的 DD-6 guard 被繞過；block commit |
| `client.freshness.flag_enabled == 1` 比例趨近 0 | dashboard（未來） | rollout 前 1，rollout 後依階段 | rollout 倒退中 |

---

## 量測腳本

本 plan 的 minimal 實用工具：

### 1. `scripts/freshness-audit.sh`（新，Phase 4 對應 task 4.3 的 grep guard）

```bash
#!/usr/bin/env bash
# 驗 R4.S1 / DD-6：確認 packages/app/src 下沒有 connectionStatus / authorityBlocked / connectionState 殘留
# 執行：bash scripts/freshness-audit.sh
# 預期：exit 0 + 無輸出
set -euo pipefail

MATCH=$(
  rg --type ts --type tsx \
    --glob '!docs/**' --glob '!*.md' \
    -e 'connectionStatus|authorityBlocked|connectionState' \
    packages/app/src/ || true
)
if [ -n "$MATCH" ]; then
  echo "DD-6 violation detected:"
  echo "$MATCH"
  exit 1
fi
echo "DD-6 guard PASS: no residual connection-state references"
```

### 2. `scripts/freshness-repro.md`（新文件，Phase 5 task 5.3 操作步驟）

手動重現 R2.S2 / R2.S3 的 step-by-step：
1. 啟 daemon + web：`./webctl.sh dev-refresh`
2. 瀏覽器開一 session，觀察 `receivedAt` 持續更新（DevTools console 看 `[freshness] tweaks loaded`）
3. 找 daemon gateway 的 PID：`ps aux | grep opencode-gateway`
4. `sudo kill -STOP <pid>`（凍結 gateway，停送 SSE）
5. 計時：15s 內 UI 出現 "updated Ns ago" hint / 60s 內 card 灰化
6. `sudo kill -CONT <pid>` 恢復；UI 應在下一個 event 抵達後回復 fresh
7. 驗收：timing 誤差 ±2s 容忍

### 3. Dev console helper（task 2.1 的 useFreshnessClock 建檔時順便加）

暴露 `window.__opencodeDebug.freshnessNow()` 讓 DevTools 直接讀當下 tick 值（只在 `import.meta.env.DEV`）。

---

## Dashboard mockup（未來）

```
┌─ Session UI Freshness (client) ─────────────────────┐
│ Active sessions: 5                                   │
│ Stale entries:      2 / 47   ████▒▒▒▒▒▒ 4.3%         │
│ Hard-stale entries: 0 / 47   ▒▒▒▒▒▒▒▒▒▒ 0.0%         │
│ Invalid timestamps: 0        ✓                       │
│ Flag enabled:       1        ✓                       │
│ Tweaks load 30d: 99.7% (3 failures)                  │
└──────────────────────────────────────────────────────┘
```

Rollout 階段用，穩定後移除（flag 退場 amend 連同此 dashboard 一起收）。
