# Observability — compaction_central-manager

The manager is the single place where "why did this session compact / enrich" is
answerable. Every request produces one structured record at the intake; policy
violations produce anomaly events. Forensic reconstruction across the runtime
journal + multiple debug.logs (what the RCA required) collapses to a query.

## Events

All events are appended to the runtime event journal (RuntimeEventService),
scoped by `sessionID`, carrying `origin` + structured `cause`.

| Event | When | Key payload |
|---|---|---|
| `compaction.request` | every `submit()` | `kind`, `origin`, `cause` (structured), `provider`, `decision` |
| `compaction.executed` | a kind chain commits an anchor | `anchorId`, `kind`, `observed`, `provider`, `latencyMs` |
| `compaction.published` | post-anchor chain-reset fan-out | `anchorId`, `kind`, `ssBreakClass` |
| `compaction.enriched` | enrichment served for an anchor | `anchorId`, `path` (drop_old/ai_paid), `tokensBefore`, `tokensAfter` |
| `compaction.evaluate_noop` | arbitration returns no observed | `cause`, `reason` (cooldown/freerun/provider-noop) |
| `compaction.anomaly` | any policy violation | `code` (see errors.md), `origin`, violation-specific fields |

Existing telemetry kept for continuity: `compaction.recompress` (now emitted at
most once per anchor), `session.rebind` (unchanged), `enrichment:{success,failed}`
recentEvents ring.

## Metrics

| Metric | Type | Purpose / alert |
|---|---|---|
| `compaction.requests_total{origin,kind,provider}` | counter | request volume by source; spot a hot/duplicating origin |
| `compaction.enrich_dedup_total{result}` | counter | `result=served\|rejected`; **rejected > 0 means the bug class is being caught** (S1 tripwire) |
| `compaction.recompress_per_anchor` | histogram | **must be ≤ 1**; > 1 is the double-trim regression |
| `compaction.anomaly_total{code}` | counter | per-anomaly rate; `publish-kind-mismatch` / `duplicate-enrich` should trend to 0 post-migration |
| `compaction.lock_held_ms` | histogram | per-session lock hold time; backstops `lock-held-too-long` |
| `compaction.evaluate_noop_total{reason}` | counter | how often arbitration declines; cross-trigger pattern detection (e.g. cache-thrash) |
| `compaction.compact_latency_ms{kind,provider}` | histogram | execution cost by kind/provider; equivalence check across slices |

### RCA-ledger query path

"Why did session X compact/enrich, how often, on what numbers" =
`event_query`/`event_search` over `compaction.request` + `compaction.anomaly`
scoped to the session — no debug.log archaeology. Cross-trigger patterns
(repeated `cache-aware` = cache thrash; alternating `overflow`/`cache-aware` =
threshold fighting) are visible because all causes land in one ledger.
