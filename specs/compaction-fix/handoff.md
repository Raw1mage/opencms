# Handoff: compaction-fix

State: living. Merged to `main` in commit `01aca5124` (2026-05-09).
No active execution work — this document records validation evidence
and the operating contract for downstream readers.

## Operating Contract

Three runloop-level compaction triggers, all gated by
`itemCount > 250` (with token-ratio companion at rebind):

| Trigger | When it fires | Compaction observed |
|---|---|---|
| Paralysis × bloated-input | 3-turn paralysis triple + items > 250 | `overflow` |
| ws-truncation × bloated-input | `lastFinished.finish ∈ {unknown, error, other}` + items > 250 | `empty-response` |
| Pre-emptive rebind | step=1, items > 250 OR tokenRatio > 0.7 | `rebind` |

Phase 2 anchor-prefix expansion runs at every prompt assembly when
the anchor carries valid `serverCompactedItems` (chain-binding match
required). Codex provider always tries `low-cost-server` first in the
KIND_CHAIN.

Feature flags:
- `compaction_phase1_enabled = 0` (per-turn transformer disabled)
- `compaction_phase2_enabled = 1` (anchor-prefix expansion live)

## Validation Evidence

### A1 — Three trigger sites correct

- Paralysis trigger: unit-tested via existing paralysis-detector
  tests; integration verified live on yieU7oSTLOPY session
  (compaction fired after 3-turn narrative repetition).
- ws-truncation trigger: live verification on yieU7oSTLOPY session,
  itemCount 487 → compaction → next slice ~50 items, anchor written
  (2 anchors visible in session DB post-event).
- Pre-emptive rebind: live verification 2026-05-09, daemon restart
  with bloated session triggered compaction at step=1 before WS open.

### A2 — Phase 2 expansion + chain binding

- 10 unit cases in
  `packages/opencode/test/session/anchor-prefix-expand.test.ts`
  cover: valid expansion, chain-binding match, mismatch fallback,
  message-type splitting, JSON wrapper for non-message types,
  empty input, no-anchor noop.

### A3 — resolveKindChain codex-first

- Unit cases in
  `packages/opencode/test/session/compaction.test.ts` cover:
  codex sub at high ctx → server first; codex non-sub at high ctx →
  server first (sub flag no longer gates); codex at low ctx → server
  first (no threshold gate); non-codex unchanged regardless of
  subscription / context.

### A4 — Graceful degradation on compaction failure

- All three trigger sites wrap `SessionCompaction.run` in try/catch
  with structured warn log; on failure, fall through to the original
  code path (paralysis nudge / live LLM request / rebind continuation).

### A5 — Layer purity holds across rotation/rebind

- L4 chain reset paths (`transport-ws.ts:561/571/581/607`) all
  invalidate continuation family without touching L2 anchor content.
- `chainBinding` validation at projection time rejects compactedItems
  produced under a different `(accountId, modelId)` pair, ensuring
  rotation/rebind never serves stale chain-internal references.

### A6 — Feature flags independent

- `compaction_phase2_enabled` no longer requires `compaction_phase1_enabled`
  to be on (decoupled in commit `c1feb48a1`).
- Default config: phase1=0, phase2=1.

## References

- gpt-5.5 itemCount RCA:
  [docs/events/event_20260509_gpt55_itemcount_truncation_rca.md](../../docs/events/event_20260509_gpt55_itemcount_truncation_rca.md)
- Empty-turn classifier RCA:
  [specs/fix-empty-response-rca/](../fix-empty-response-rca/)
- Architecture compaction section:
  [specs/architecture.md](../architecture.md)
