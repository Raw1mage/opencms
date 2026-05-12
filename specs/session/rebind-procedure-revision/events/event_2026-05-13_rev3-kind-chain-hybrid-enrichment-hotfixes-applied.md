---
date: 2026-05-13
summary: "rev3: KIND_CHAIN + hybrid enrichment hotfixes applied to main"
---

# rev3: KIND_CHAIN + hybrid enrichment hotfixes applied to main

# Revision 3 — rev1 + rev2 hotfixes applied to main

Single combined commit on main applying both observation-class
revisions to `packages/opencode/src/session/compaction.ts`:

## Part A — rev1 KIND_CHAIN extension (compaction.ts:874-876)

Extended rebind-class compaction chains from `[narrative, replay-tail]`
to `[narrative, replay-tail, low-cost-server, llm-agent]` so dialog-
heavy rebind-driven compactions can fall through to LLM-driven
reduction when narrative's deterministic concat fails to shrink
context. Applied to `rebind`, `continuation-invalidated`,
`provider-switched`, `stall-recovery`. `idle` and `empty-response`
left untouched (intentional, see commit message).

## Part B — rev2 hybrid enrichment eligibility + telemetry (compaction.ts:2169, 1616-1645)

Two stacked changes:
- Extended `hybridEnrichmentEligible` set to include rebind-class
  observed values, mirroring rev1's reasoning at the next layer.
- Added `RuntimeEventService.append` calls for
  `session.hybrid_enrichment.scheduled` and
  `session.hybrid_enrichment.skipped` (with reason discriminator) at
  the function entry — closes the data-plane observability gap.

## Verification

- `tsgo --noEmit` clean
- 183 unit tests pass (was 168 before; new chain-semantics +
  fragment + continuation tests cumulative)
- Daemon restart required to load

## Lifecycle telemetry still incomplete

Only `.scheduled` and `.skipped` (entry-guards) emit events. The mid-
lifecycle (`.started`, `.succeeded`, `.failed`) — covering the actual
LLM call and the anchor-update step — still uses `log.info` only.
Tracked as **follow-up F14**: extend telemetry to cover the full
lifecycle so dashboards can show enrichment success rate / latency
distribution. Out-of-scope for this hotfix because the in-flight
code is intermingled with the dialog-redaction-anchor flag logic and
deserves its own audit pass.

## Live verification pending

Requires daemon restart + a rebind-class compaction event after
restart to confirm telemetry shows the new events. Expected
sequence on next account_switch in a context-heavy session:
1. `chain.commitment.captured` + `session.rebind` + `chain.init.injected`
2. Compaction fires with observed=rebind
3. KIND_CHAIN now tries narrative first then falls through to
   low-cost-server if narrative didn't reduce enough
4. After compaction publish, `session.hybrid_enrichment.scheduled`
   fires (NEW telemetry)
5. Background enrichment runs; success/failure visible via
   `Log` for now (full lifecycle telemetry per F14 above)

## Commit reference

main HEAD: see git log around 2026-05-13 — commit message
"fix(compaction): extend rebind-class compactions to LLM-driven kinds
+ telemetry"

## Status

- [x] Code changes on main
- [x] tsgo clean
- [x] 183 tests pass
- [ ] Daemon restart (user consent required)
- [ ] Live verification of new telemetry events post-restart
- [ ] F14: full enrichment lifecycle telemetry
