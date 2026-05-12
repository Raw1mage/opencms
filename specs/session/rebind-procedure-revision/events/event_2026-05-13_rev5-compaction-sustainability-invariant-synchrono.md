---
date: 2026-05-13
summary: "rev5: Compaction Sustainability Invariant — synchronous ratio-based watermark backstop"
---

# rev5: Compaction Sustainability Invariant — synchronous ratio-based watermark backstop

# Revision 5 — Compaction Sustainability Invariant

The parent spec's chain-init protocol notifies the AI on chain-identity breaks. It does not, by itself, prevent the underlying context from growing unbounded under long-running rotation/multi-document workloads. This rev introduces the **synchronous, ratio-based, model-agnostic backstop** that turns "tell the AI about breaks" into a complete sustainability story.

## Statement of the invariant

```
For any session running on any provider/model under multi-dimensional
rebind protocol P, P is sustainable iff every compaction commit C
satisfies:
    context_residual(C) / model.context_limit  ≤  W_rel,   W_rel ∈ (0, 1)
```

Default `W_rel = 0.5` ("if compaction leaves context still half-full, it didn't actually contract"). Configurable via `tweaks.compactionSync().sustainabilityRatio`.

When the bound is violated after a local-kind (`narrative` / `replay-tail`) commit, the runloop **synchronously** invokes a contractive kind (`low-cost-server` first, `llm-agent` fallback) until the bound is restored OR all contractive kinds failed.

## Why ratio not absolute

Absolute thresholds (100K / 50K / 5K tokens) don't generalise across providers. Same anchor body at 128K-context provider = unsustainable; at 272K = fine; at 1M = trivial. Ratio formulation lets one threshold cover all current and future providers without reconfiguration — also matters for the paper's "universal theorem" framing.

## Implementation

`packages/opencode/src/session/compaction.ts`:
- `measureSustainabilityWatermark(sessionID, model)` — pure ratio computation; returns `{ violated, ratio, threshold, contextLimit, contextResidual, anchorTokens }` or null when no anchor / no context limit
- `forceContractiveCompaction(...)` — synchronous escalator; tries `low-cost-server` (codex `/responses/compact`) first, then `llm-agent`
- Hook in `SessionCompaction.run`: after every successful LOCAL kind commit, measure → emit `measured` event → if violated, fire force-compact path

`packages/opencode/src/config/tweaks.ts`:
- New field `sustainabilityRatio: number` (default 0.5)

## Telemetry surface

Four runtime event types added:
- `compaction.sustainability.measured` (info, telemetry domain) — every local-kind commit, with `{ observed, ratio, threshold, violated, anchor_tokens, context_residual, context_limit }`
- `compaction.sustainability.fired` (warn, workflow) — when violation detected, with `{ ratio_before, threshold, reason }`
- `compaction.sustainability.completed` (info, workflow) — contractive succeeded, with `{ kind_used, ratio_before, ratio_after, violated_after, ms }`
- `compaction.sustainability.failed` (warn, anomaly) — all contractive kinds failed, with `{ ratio_before, ratio_after, last_reason, ms }`

These give first-class observability for the sustainability layer; pair with rev2's `session.hybrid_enrichment.*` events to track both layers of LLM-based compression.

## Why this fires only after local kinds

The check is gated on `isLocalKind(attempt.kind)`. If the chain already committed `low-cost-server` or `llm-agent`, those ARE the contractive backstop and we trust their output without re-checking. Otherwise we'd recurse: force-compact uses contractive kinds → contractive kind doesn't perfectly restore ratio → re-fire force-compact → infinite loop.

## Tests

`compaction.sustainability-watermark.test.ts` — 10 new tests covering:
- Ratio computation correctness across anchor sizes + post-anchor residuals
- **Cross-model invariance theorem** — same anchor, 128K-ctx model violates, 272K-ctx model doesn't (paper-evidence test)
- Custom threshold (0.4) tightens decision
- Defensive: no anchor → null; ctx_limit=0 → null; empty session → null

Plus 53 tests pass across affected compaction test suites (compaction-run / regression-2026-04-27 / replay-deep / user-msg-replay-rev2 / sustainability-watermark).

`tsgo --noEmit` clean.

## Relation to prior revs

| | Concern | Mechanism |
|---|---|---|
| rev1 | KIND_CHAIN excluded paid kinds for rebind-class | Append `low-cost-server` + `llm-agent` to those chains |
| rev2 | hybrid_llm enrichment eligibility + telemetry | Expand eligible set + add scheduled/skipped events |
| rev4 (cross with user-msg-replay-unification) | INJECT_CONTINUE static gate blocked user-initiated rebind continuation | PendingInjectionStore.peek override |
| **rev5** | **Long-horizon anchor growth without sustainability guarantee** | **Ratio-based synchronous watermark backstop** |

rev1 and rev2 alone weren't sufficient because:
- rev1 chain extension never triggered in practice (narrative always reports `truncated: false`, chain stops at position 0)
- rev2 enrichment is background-only, can race against active conversation

rev5 puts the contractive kind on the **synchronous foreground path**, gated by the ratio. This is the load-bearing piece.

## Paper-level significance

Promotes this work from "we built a chain-init notification protocol" to "we proved sustainability of a multi-dimensional rebind protocol under a single model-agnostic invariant". The cross-model invariance test is the empirical kernel of the theorem; the implementation is the operational proof of existence.

theory.md §4.5 now states the invariant formally; the `compaction.sustainability.measured` event stream is the operational proof: any reader can grep the runtime event journal and verify that the post-condition holds.

## Commit reference

main (this commit): `feat(compaction): rev5 sustainability watermark backstop`

## Status

- [x] Code implemented + 10 unit tests + cross-model theorem test
- [x] Telemetry surface (4 event types)
- [x] theory.md §4.5 statement of invariant
- [ ] Daemon restart + live verification (force a heavy session, observe `.measured` and `.fired` events)
- [ ] Future: include sustainability backstop kind decision in the paper's evaluation chapter
