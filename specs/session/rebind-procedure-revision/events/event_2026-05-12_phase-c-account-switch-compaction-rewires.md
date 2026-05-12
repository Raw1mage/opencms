---
date: 2026-05-12
summary: "Phase C account-switch + compaction rewires"
---

# Phase C account-switch + compaction rewires

`9a6f52c20` — rewired three sites:
- prompt.ts:460 (in-loop anchor account swap, deriveObservedCondition)
- prompt.ts:1208 (pre-loop account switch detection; subsumed prior `RebindEpoch.bumpEpoch + invalidateContinuationFamily` pair)
- compaction.ts:189 publishCompactedAndResetChain — every compaction publish site funnels through

New helper `mapCompactionEventMetaToKind` translates (observed, kind) telemetry into the precise compaction_* event kind (narrative / cache_aware / stall_recovery / preemptive_daemon_restart / server_side).

compaction.ts:3622 intentionally kept as direct invalidateContinuationFamily — it's a pre-LLM-compaction scrub before the compaction agent runs; the runLlmCompact finally block (3595) handles post-compaction notice via the Phase C rewired publishCompactedAndResetChain.

5 → 1 remaining direct invalidate caller.</body>
