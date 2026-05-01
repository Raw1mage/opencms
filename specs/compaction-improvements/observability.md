# Observability: compaction-improvements

## Events

- `compaction.predicate.evaluation`: trigger id, inputs, fired/skipped reason.
- `compaction.mode1.fired`: codex Mode 1 response item observed.
- `compaction.chain.reordered`: provider, subscription flag, ctx ratio, before/after chain.
- `compaction.narrative.coverage`: total turns, covered turns, coverage ratio, pass/fail.
- `compaction.cooldown.blocked`: would-fire trigger and anchor age.
- `context.budget.surfaced`: status, ratio, as_of, session kind.
- `input.preprocessing.routed`: mime, size, threshold, ref type.
- `input.preprocessing.rejected`: mime, size, explicit reason.
- `subagent_return.routed`: subagent type, size, ref id metadata only.
- `worker.invocation.failed`: tool id, ref type, error code.

## Metrics

- Predicate fire rate by trigger id.
- Codex low-cost-server first-kind success rate.
- Budget status distribution per provider.
- Attachment/subagent routing size distribution.

## Privacy

Telemetry must not include raw attachment bytes, full user text, OAuth tokens, provider headers, or raw subagent reports.
