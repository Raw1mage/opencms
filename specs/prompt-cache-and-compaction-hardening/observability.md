# Observability: prompt-cache-and-compaction-hardening

## Events

### Telemetry Events

所有事件透過 `Bus.publish` 發；payload schema 對齊 [data-schema.json `PromptCacheTelemetryEvent`](./data-schema.json)。

### Cache 事件 (DD-13)

| Event | When | Payload | Phase |
|---|---|---|---|
| `prompt.cache.system.hit` | LLM 回應 header 顯示 BP1 區段 cache 命中 | `{ sessionID, turnIndex, cachedTokens }` | B |
| `prompt.cache.system.miss` | BP1 cache miss | `{ sessionID, turnIndex }` | B |
| `prompt.cache.preface.t1.hit` | BP2 命中 | `{ sessionID, turnIndex, cachedTokens }` | B |
| `prompt.cache.preface.t1.miss` | BP2 miss | `{ sessionID, turnIndex }` | B |
| `prompt.cache.preface.t2.hit` | BP3 命中 | `{ sessionID, turnIndex, cachedTokens }` | B |
| `prompt.cache.preface.t2.miss` | BP3 miss | `{ sessionID, turnIndex }` | B |

> Phase B 才有 BP2/BP3；Phase A 期間僅 `prompt.cache.system.{hit,miss}` 有效（且 Phase A 不改 system 結構，所以這幾個事件其實仍然反映舊行為，僅作為對比基線）。

### Compaction 事件 (DD-13)

| Event | When | Payload | Phase |
|---|---|---|---|
| `compaction.cache_miss_diagnosis` | `shouldCacheAwareCompact` 評估完 | `{ sessionID, kind, lastSystemHashes:[...trimmed-hex8], conversationTailTokens }` | A |
| `compaction.idle.deferred` | `idleCompaction` clean-tail gate 退出 | `{ sessionID, reason, scannedMessageCount }` | A |
| `compaction.anchor.sanitized` | sanitizer 成功處理 | `{ sessionID, kind, originalLength, sanitizedLength, imperativePrefixApplied }` | A |
| `compaction.anchor.sanitize_failed` | sanitizer defensive fail（理論不該發生） | `{ sessionID, kind, error }` | A |
| `capability_layer.cross_account_rebind_failed` | DD-8 hard-fail throw | `{ sessionID, from, to, failures }` | A |
| `skill.pin_for_anchor` | DD-9 auto-pin | `{ sessionID, anchorId, skillName, reason }` | A |
| `skill.unpin_by_anchor` | DD-9 anchor supersede | `{ sessionID, anchorId, unpinnedNames:[...] }` | A |
| `plugin.context_transform.failed` | DD-11 plugin 例外 | `{ sessionID, pluginName, error }` | B |
| `plugin.legacy_dynamic_injection_warn` | 偵測 legacy hook 注入 dynamic | `{ pluginName, sampleSnippet }` | B |

## Metrics

衍生自 telemetry：

| Metric | Definition | Target | Phase |
|---|---|---|---|
| `prompt_cache_system_hit_rate` | `sum(prompt.cache.system.hit) / sum(prompt.cache.system.{hit,miss})` per session | ≥ 95% (穩定 session) | B |
| `prompt_cache_preface_t1_hit_rate` | 同上 for BP2 | ≥ 80% | B |
| `prompt_cache_preface_t2_hit_rate` | 同上 for BP3 | ≥ 60% | B |
| `compaction_idle_defer_rate` | `count(compaction.idle.deferred) / count(idleCompaction-eval)` | < 5% | A |
| `compaction_diagnosis_churn_rate` | `count(diagnosis.kind=system-prefix-churn) / count(diagnosis.*)` | < 10% | A |
| `cross_account_rebind_failed_per_session` | count per session per day | < 1 | A |
| `anchor_sanitize_imperative_rate` | `count(sanitized.imperativePrefixApplied=true) / count(sanitized.*)` | observe — 過高暗示 compaction agent prompt 沒控制好 | A |
| `skill_pin_count_per_session` | active `pinForAnchor` 累積數 | < 20 | A |

## Logs

結構化 log via `Log.create({ service })`：

- `service: "anchor-sanitizer"` — 每次 sanitize 結果（含 imperative pattern 命中行）
- `service: "idle-compaction-gate"` — clean-tail 結果 + 掃描範圍
- `service: "capability-layer"` — fallback 決策 + cross-account 比對
- `service: "skill-anchor-binder"` — pinForAnchor / unpinByAnchor 呼叫
- `service: "cache-miss-diagnostic"` — 滾動視窗內的 hash 變動序列

## Dashboards (建議)

Grafana 面板（如有，否則手動 query）：

| Panel | Source | Period |
|---|---|---|
| Cache hit rate（system / preface.t1 / preface.t2） | metrics 表 | 24h, 7d |
| Compaction 觸發原因分布（observed=overflow/idle/cache-aware/...） | `compaction.observed` event | 7d |
| `idle.deferred` 比例與 reason 分布 | `compaction.idle.deferred` | 7d |
| `cache_miss_diagnosis.kind` 分布 | telemetry | 24h |
| `cross_account_rebind_failed` 時序 | telemetry | 7d |
| Skill pin 累積（per session） | `skill.pin_for_anchor` minus `skill.unpin_by_anchor` | live |

## Alerts

| Alert | Condition | Action |
|---|---|---|
| `cross_account_rebind_failed` 同 session 連 3 次 | 5 min 視窗 | page on-call |
| `compaction.anchor.sanitize_failed` 任何 1 次 | 即時 | page |
| `compaction_idle_defer_rate` 持續 > 20% (1h) | 連 3 個 1h bucket | 看 subagent settle / dispatch race |
| `cache_miss_diagnosis.kind=system-prefix-churn` 持續 > 30% (1h) | 連 3 個 bucket | 看 SYSTEM.md / AGENTS.md 是否頻繁編輯 |
| `prompt_cache_system_hit_rate` < 80% (24h average, Phase B 期間) | 連續 24h | 反查 static tuple 是不是真的穩定 |

## Manual smoke checks (Phase A)

完成 Phase A 各 task 後在 beta worktree（`source .beta-env/activate.sh`）：

```bash
# 跑 5 turns 後查 telemetry log
opencode session show --json | jq '.events[] | select(.name | startswith("compaction."))'

# 故意觸發 compaction
opencode /compact

# 確認 anchor body
opencode session messages --tail 1 --json | jq '.[].parts[].text' | head -1
# expected: starts with <prior_context source="manual"...>
```

## Manual smoke checks (Phase B)

```bash
# Phase B feature flag
export OPENCODE_PROMPT_PREFACE=1

# 跑 10 turns，然後查
opencode session show --json | jq '.events[] | select(.name | startswith("prompt.cache."))'

# 應該看到 BP1/BP2/BP3 各有 hit 與 miss 紀錄；前 1-2 turn 全 miss，後續 hit 比例上升
```

## Backwards compat observability

Phase B 上線後，仍可關 flag 回退：

```bash
unset OPENCODE_PROMPT_PREFACE
# 或
export OPENCODE_PROMPT_PREFACE=0
```

關 flag 時：BP2/BP3 telemetry 不應再出現。若仍出現 = 路徑沒乾淨切換，需查 [llm.ts](../../packages/opencode/src/session/llm.ts) 的 flag 判斷。
