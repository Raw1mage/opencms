# Observability

## Events

Lifecycle events worth recording (via `spec_record_event` or logs): events-index rebuild started/completed, spec-isolation check passed/failed, MEMORY.md migration classified, migration verification passed, MEMORY.md emptied, EVENT_LOG_UNIFIED.md retired.

## Metrics

### Index rebuild (Phase 1)

Emit from the events indexer (mirror specbase's IndexResult):

- `events.index.scanned` — files found by the glob.
- `events.index.written` — entries successfully indexed.
- `events.index.removed` — entries dropped since last build.
- `events.index.undated` — files with no parseable filename date (created=null).
- `events.index.errors` — parse failures (with slug + error).
- `events.index.duration_ms` — full-rebuild wall time (watch against AC9 ~1-5s).
- `events.index.db_bytes` — events.sqlite size after build (watch against AC9 < 35MB).

## Spec-isolation guard (AC2)

- Log spec-index counts (`entries`, `links`, fts_rows) before and after the events build; assert unchanged. Any delta is a contamination alarm.

## Query surface (Phase 2)

- `events.query.latency_ms` — per `event_search` / `event_query` call (watch against AC3 < 50ms).
- `events.query.hits` — result count returned.
- `events.query.empty` — count of queries returning zero hits (signal for terminology mismatch / triggering quality).

## Migration (Phase 5-6)

- `memory.migrate.classified` — entries classified, by bucket (rule / history / procedure / churn).
- `memory.migrate.verified` — migrated items confirmed findable.
- `memory.migrate.unverified` — items still blocking the empty gate (must reach 0 before P6-2).
- Event record (`spec_record_event`) at retirement capturing rebuild metrics, isolation proof, and the verification list.

## Health signals to watch post-cutover

- Ratio of `events.query.empty` over time — rising empties hint the routing rule or keywords need tuning (the residual triggering risk).
- MEMORY.md size == 0 and no resident-knowledge regressions (cache-write churn gone).
