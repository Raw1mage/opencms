# Errors — compaction_post-compaction-continuity

## Error Catalogue

Failure modes this spec turns from silent into correct/observable:

| Failure (today) | Class | Cause | Fix | Slice |
|---|---|---|---|---|
| Tile shows a phantom second compaction | telemetry-misreport | enrichment pushed as `kind:"compaction"` | first-class `enrichment` kind | S1 |
| Amnesia notice silently suppressed | decision-poisoning | `decideAmnesiaInjection` short-circuits on the fake-compaction enrichment entry | enrichment no longer `kind:"compaction"` → reverse scan reaches the real anchor | S1 |
| Unnecessary SS-break amnesia on claude | over-trigger | legacy size/cache policy fires regardless of provider/headroom | per-provider gate declines for claude | S2 |
| Interrupted task stranded | liveness | `empty_continue_text` → `no_user_after_compaction` clean exit while unfinished | resume the unfinished turn | S3 |

## Failure-handling principles

- **Honest telemetry.** An event is reported as what it is; enrichment is never
  filed under compaction. Mislabeled telemetry that also drives a decision is a
  correctness bug, not a cosmetic one (S1 is the proof).
- **No silent strand.** A compaction must not leave an in-flight user request
  unanswered; the loop continues the task or, if genuinely finished, exits — but
  never strands an unfinished turn waiting for a manual nudge.
- **No infinite resume.** The resume path is gated on a genuinely-unfinished turn
  and must coexist with the unproductive-round breaker; a finished turn stays
  finished.
- **Provider-local gating.** The claude decline (S2) lives in the provider
  strategy; it must not alter codex/general compaction. Out-of-scope creep is a
  stop gate.
