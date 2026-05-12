---
date: 2026-05-12
summary: "SkipReason polish: amnesia_supersedes for compaction kinds"
---

# SkipReason polish: amnesia_supersedes for compaction kinds

`670c44046` — compaction events were emitting `chain.init.skipped` with `reason: "unspecified"` because the four compaction shapes had `injectsChainInit=false / injectsAmnesia=true` but no explicit `skipReason`. These aren't suppressions — they hand the AI notification responsibility to amnesia_notice. New `SkipReason` variant `"amnesia_supersedes"`; dashboards filtering chain.init.skipped now see WHY each skip happened:

- `"user_clear"` / `"subagent_spawn"` / `"sl_provider"` — genuine suppressions
- `"amnesia_supersedes"` — amnesia carries the notice instead
- `"server_side_compaction"` — chain preserved by codex
- `"capability_only"` / `"ws_reconnect"` / `"no_prior_chain"` — no break occurred
