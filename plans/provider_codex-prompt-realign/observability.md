# Observability: provider_codex-prompt-realign

## Events

| Event | Source | When | Payload |
|---|---|---|---|
| `[CODEX-WS] USAGE` | transport-ws.ts:543 | response usage frame | input_tokens / output_tokens / cached_tokens / hasPrevResp |
| `[CODEX-WS] REQ` | transport-ws.ts | each outbound request | delta / inputItems / fullItems / prevResp / hasPrevResp / tail |
| `prompt.bundle.assembled` (new) | llm.ts (post Stage A.3) | per turn assembly | driverHash / developerBundle / userBundle fragmentIds |
| `prompt.preface.assembled` (legacy, retiring) | llm.ts:868 | per turn assembly (legacy path) | staticBlockHash / t1Chars / t2Chars / trailingChars |
| `session.round.telemetry` | processor.ts:1254 | every round complete | cacheReadTokens / inputTokens / observedTokens |
| `system.instructions.drift` (new, conditional) | cache-miss-diagnostic | driver hash unexpectedly changes | prev_hash / curr_hash / model_id |

## Metrics

| Metric | Type | Target |
|---|---|---|
| `codex.cache_hit_ratio` (per session, per turn) | gauge | ≥ 0.9 from turn 2 onward |
| `codex.cached_tokens_stuck_4608` (count of sessions per day) | counter | 0 for sessions started post-Stage-A |
| `codex.driver_hash_unique_per_session` | gauge | 1 for single-driver sessions |
| `codex.instructions_byte_size` (per session) | gauge | stable within a single driver |
| `codex.prompt_cache_key_includes_accountid` (boolean per request) | gauge | false (post Stage A.4) |
| `codex.chain_reset_count_per_upgrade` | counter | exactly N where N = active sessions at upgrade time |

## Signals

### S1 — `[CODEX-WS] USAGE` log line per turn

來源: [packages/opencode-codex-provider/src/transport-ws.ts:543](packages/opencode-codex-provider/src/transport-ws.ts#L543)

格式:
```
[CODEX-WS] USAGE session=<sid> model=<id> input_tokens=<n> output_tokens=<n> total_tokens=<n> reasoning_tokens=<n> cached_tokens=<n> hasPrevResp=<bool>
```

關鍵欄位:
- `cached_tokens` — 主要驗收信號。Stage A 完成後第二 turn 起應 ≥ 0.9 × `input_tokens`
- `hasPrevResp` — true 為 delta 模式，false 為 fresh / chain reset
- `session=<sid>` — 跟 `prompt_cache_key` 應該相等（Stage A.4 後）

### S2 — `[CODEX-WS] REQ` log line per turn

格式:
```
[CODEX-WS] REQ session=<sid> delta=<bool> inputItems=<n> fullItems=<n> prevLen=<n|—> prevResp=<id|—> hasPrevResp=<bool> tail=[...]
```

關鍵欄位:
- `inputItems` vs `fullItems` 比例：delta=true 通常 inputItems << fullItems
- `tail` — 最後三個 input item 的 role + 開頭 60 字元摘要。Stage A 後不該再看到 `## CONTEXT PREFACE` 字樣

### S3 — `prompt.preface.assembled` log (legacy, 將移除)

來源: [packages/opencode/src/session/llm.ts:868](packages/opencode/src/session/llm.ts#L868)

Stage B.3 廢除 context-preface 後，此 log 一併移除。改成新 log:

### S4 — `prompt.bundle.assembled` log (new)

預期格式:
```json
{
  "sessionID": "...",
  "driverHash": "<sha256-12prefix>",
  "driverChars": <int>,
  "driverTokens": <int>,
  "developerBundle": {
    "fragmentIds": ["role_identity", "opencode_protocol", "apps_instructions", ...],
    "totalChars": <int>,
    "totalTokens": <int>
  },
  "userBundle": {
    "fragmentIds": ["agents_md:global", "agents_md:project", "environment_context"],
    "totalChars": <int>,
    "totalTokens": <int>
  }
}
```

### S5 — Cache miss diagnostic (existing, repurposed)

[packages/opencode/src/session/cache-miss-diagnostic.ts](packages/opencode/src/session/cache-miss-diagnostic.ts) 的 `recordSystemBlockHash` 仍可用，但 hash 對象從整個 staticBlock 變成 driver-only。

`diagnoseCacheMiss(...)` 三類結果：
- `system-prefix-churn` — driver hash 變動（model switch / driver upgrade）
- `conversation-growth` — driver 穩定但對話太長
- `neither` — 無資料

### S6 — `session.round.telemetry` event (existing)

來源: [packages/opencode/src/session/processor.ts:1254](packages/opencode/src/session/processor.ts#L1254)

`cacheReadTokens` 欄位是主要驗收統計。整合到 dashboard 後可看每 session 隨 turn 數的 cache hit ratio 走勢。

### S7 — `system.instructions.drift` event (new, conditional)

當 `recordSystemBlockHash` 偵測同 session 連續兩 turn 的 driver hash 不同**且**沒有 model switch → emit `system.instructions.drift` runtime event（domain=`workflow`, level=`warn`）。

Payload:
```json
{
  "sessionID": "...",
  "prev_hash": "...",
  "curr_hash": "...",
  "model_id": "...",
  "turn_index": <int>
}
```

## Dashboards / Queries

### Q1 — Cache hit ratio over turns (per session)

```sql
-- pseudocode
SELECT
  session_id,
  turn_index,
  cache_read_tokens / NULLIF(input_tokens, 0) AS cache_hit_ratio
FROM session_round_telemetry
WHERE provider_id = 'codex'
ORDER BY session_id, turn_index;
```

驗收：第二 turn 起 ratio ≥ 0.9。

### Q2 — Sessions stuck at cached_tokens=4608

```sql
SELECT session_id, COUNT(*) AS stuck_turns
FROM codex_ws_usage_log
WHERE cached_tokens = 4608
GROUP BY session_id
HAVING stuck_turns >= 3;
```

Stage A 完成後此 query 不該回傳本 plan 之後新建的 session。

### Q3 — instructions hash distribution per session

```sql
SELECT
  session_id,
  COUNT(DISTINCT driver_hash) AS unique_hashes_in_session,
  COUNT(*) AS turns
FROM prompt_bundle_assembled
WHERE provider_id = 'codex'
GROUP BY session_id
HAVING unique_hashes_in_session > 1;
```

驗收：unique_hashes_in_session = 1 對於所有 single-driver sessions。

## Alarms

### A1 — Cache regression alarm

連續 N 個 healthy delta turn (`hasPrevResp=true`) 平均 `cached_tokens / input_tokens < 0.5` → page。

預設 N=5。

### A2 — Instructions drift in steady-state

S7 `system.instructions.drift` event 在沒有 model switch / refresh_capability_layer 的情況下 fire → warn-level alert。

### A3 — Persona file integrity

啟動時 `prompt/codex.txt` md5 不等於 `expected = 7a62de0a7552d52b455f48d9a1e96016` → fatal 開機失敗（DD-2 + E1 contract）。

## Stage-specific observability

| Stage | What to watch |
|---|---|
| A.1 (done) | persona file md5 一致；無觀測影響 |
| A.2 | unit test 通過；不影響 runtime |
| A.3 | S2 REQ log 不再含 `## CONTEXT PREFACE`；S1 USAGE `cached_tokens` 第二 turn 跳脫 4608 |
| A.4 | S2 REQ 的 prompt_cache_key 對應的 fingerprint hash 在 rotation 前後一致 |
| A.5 | 開機後一次性 `resetWsSession` 廣播；S1 USAGE 第一個請求 `hasPrevResp=false` 確認 |
| B.1-B.5 | S4 prompt.bundle.assembled 列出新 fragment ids；Q3 hash 穩定性持續驗證 |

## Telemetry implementation notes

- 新增 `prompt.bundle.assembled` 事件對齊 `bus.session.telemetry.updated` 的 envelope，含 `fragmentIds` 陣列方便 debug
- `prompt_cache_key` 不要 log 原文（含 sessionId 屬於敏感範圍），只 log 16-char SHA256 prefix（同現有 `promptCacheKeyHash`）
- driver hash 用 SHA256 前 12 字元（同現有 `staticBlockHash` 慣例）
