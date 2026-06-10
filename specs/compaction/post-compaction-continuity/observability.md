# Observability — compaction_post-compaction-continuity

The whole investigation hinged on a telemetry misread; this spec makes the
post-compaction signals say what they mean.

## Events

| Event | When | Key payload | Change |
|---|---|---|---|
| recentEvent `kind:"compaction"` | a compaction commits | `observed`, `kind`, `success` | unchanged |
| recentEvent `kind:"enrichment"` | enrichment success/failed | `status`, `tokensBefore/After` | **NEW kind (S1)** — was mislabeled `kind:"compaction"` |
| `compaction.continue.injected` | post-compaction continuation decision | `decision`, `reason`, `followUpCount` | reason `empty_continue_text` should no longer fire on an unfinished turn (S3) |
| `loop:no_user_after_compaction` | loop exit after compaction | `hasLastFinished`, `taskCount` | should NOT fire while `hasLastFinished:false` after S3 |
| provider compaction-gate decision | cache-aware/legacy trigger | `provider`, `observed`, `decision` | **NEW (S2)** — log claude declines |

## Metrics

| Metric | Type | Purpose / alert |
|---|---|---|
| `recentEvent.enrichment_total{status}` | counter | enrichment volume, now separable from compaction |
| `amnesia.inject_total{decision}` | counter | `decision=false` after a real client-side compaction should trend to ~0 (S1/DD-2 regression guard) |
| `compaction.continue.empty_text_on_unfinished` | counter | **must be 0** post-S3 — an unfinished turn that got no continuation is the D2 regression |
| `compaction.provider_declined_total{provider,observed}` | counter | how often claude declines an unnecessary compaction (S2) |

## RCA-ledger query path

"Did a compaction strand a task / suppress its notice / misreport enrichment" =
`event_search` over `compaction.continue.injected` + `loop:no_user_after_compaction`
+ the recentEvents ring, scoped to the session — no tile-screenshot guesswork.
The tile itself is now trustworthy: an `enrichment` line is enrichment, a
`compaction` line is a compaction.
