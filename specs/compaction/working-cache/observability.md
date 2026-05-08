# Observability — Working Cache / Local Cache

## Debug Checkpoints

### L1

- `working-cache.write.start`: entry id, scope kind, fact count, evidence count.
- `working-cache.write.reject`: error code, entry id, validation reason.
- `working-cache.read.select`: session id, candidate count.
- `working-cache.read.omit`: entry id, omission reason (`stale`, `invalid`, `scope`, `budget`).
- `working-cache.digest-block.parse`: assistant turn id, block count detected, parse outcome.
- `working-cache.digest-block.reject`: assistant turn id, parse error, raw block excerpt (truncated, no fact bodies).

### L2

- `working-cache.ledger.derive`: session id, entry count, derivation duration ms.
- `working-cache.ledger.fail`: session id, message ref, failure reason.
- `working-cache.recall.toolcall`: query args, found / not-found, age_turns.
- `working-cache.recall.digest`: query args, returned count, omitted count.

### Post-Compaction Manifest

- `working-cache.post-compaction.manifest`: rendered token estimate, L1 entry count, L2 entry count, omitted-from-render count.
- `working-cache.post-compaction.over-budget`: when manifest exceeds 120 tokens; provider output dropped (not truncated).

### Behavioural

- `working-cache.exploration.depth-tick`: tool name, kind, current depth, threshold.
- `working-cache.exploration.postscript-emit`: assistant turn id, depth at trigger.

## Metrics Candidates

### L1

- `working_cache_l1_entries_written_total`
- `working_cache_l1_entries_omitted_total{reason}`
- `working_cache_l1_digest_block_parse_total{outcome}`

### L2

- `working_cache_l2_ledger_entries_derived_total`
- `working_cache_l2_recall_toolcall_total{outcome}`  // outcome ∈ found / not_found / invalid_args
- `working_cache_l2_ledger_derive_duration_ms`

### Manifest

- `working_cache_manifest_render_tokens`
- `working_cache_manifest_over_budget_total`

### Behavioural

- `working_cache_exploration_sequences_total`
- `working_cache_postscript_emit_total`
- `working_cache_digest_emission_rate`  // emitted / postscript_emit, observed across N traces
- `working_cache_digest_format_compliance_rate`

## Logs

- Warnings for invalid/stale entries should include entry id and reason, not raw digest content.
- Evidence paths may be logged; raw tool outputs and secrets must not be logged.
- L2 derivation failures must log message ref and root cause; never swallow.
- `cache-digest` parse rejections may log a truncated block excerpt for debugging — never the full fact bodies if they cite secret-bearing files.

## Alerting

- No alert in MVP.
- Repeated schema-invalid writes can be investigated via debug logs.
- Repeated L2 derivation failures within one session should be investigated — they imply corrupted message storage.
- Manifest over-budget should never occur in normal operation; one occurrence justifies inspection.

## Dashboards (post-MVP)

- L2 utility: ratio of `recall_toolcall` `found` vs `not_found`. Low found rate suggests AI is not consulting L2 effectively; high not_found rate suggests AI is querying for things it never observed.
- L1 emission rate trend: per session over time. Drift downward suggests prompt-copy regression.
- Token cost vs work-saved: manifest tokens + recall tool tokens vs avoided re-Read/re-Grep tokens (estimated by hash hit rate).
