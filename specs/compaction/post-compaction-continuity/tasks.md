# Tasks — compaction_post-compaction-continuity

Three independent fixes around a correct compaction. Shipped on main
(`1977aac7b`) alongside `session/tool-output-redirection`; touched suites 98/0;
3R-deployed and live-verified.

## S1 — Enrichment is first-class, not fake-compaction (D1 / DD-1 + DD-2) — SHIPPED

- [x] Add `"enrichment"` to `SessionRecentEvent.kind` enum + optional `enrichment`
      sub-object (session/index.ts).
- [x] compaction.ts:1732 — push enrichment lifecycle as `kind:"enrichment"`.
- [x] webapp Q-card tile renders `enrichment` with its own label (session-telemetry-cards.tsx).
- [x] Regression test (DD-2/TV-1): ring `[narrative-compaction, enrichment:success]`
      ⇒ `decideAmnesiaInjection` `inject:true` for the anchor.
- [x] Verified no other recentEvents consumer relied on enrichment being `kind:"compaction"`.
- [x] SDK types regen — DEFERRED (additive enum, no sync test, runtime/webapp use
      their own types). Tracked in DD-5; non-blocking.

## S2 — claude declines unnecessary compaction (D3 / DD-4) — MOOT (superseded upstream)

- [x] MOOT per DD-5: resolved upstream by `session/tool-output-redirection` DD-7.
      With large tool results carried as ~600-token previews, promptTotal no longer
      balloons past the claude cold-cache B-gate, so the gate is not falsely
      triggered and the re-fire loop cannot form. The provider-gate / B-gate-on-
      compactible-size refactor is therefore unnecessary; left as documented hygiene.

## S3 — Resume the interrupted task (D2 / DD-3) — SHIPPED

- [x] Generalized `snapshotUnansweredUserMessage`'s interrupted-tool-chain rule
      (finish=tool-calls, no terminal stop = unanswered) from overflow-only to ALL
      observeds (compaction.ts).
- [x] Resume via the user-msg-replay-unification replay (existing mechanism).
- [x] Guard: a finished turn (finish=stop / firstStopIdx>0) stays answered — never
      re-fired (no infinite loop).
- [x] Coexists with the `evaluateUnproductiveRound` breaker (a single replay is not
      a non-productive round).
- [x] Tests: the two replay-helper tests that encoded the strand-causing overflow-
      only behaviour updated to the generalized design.

## Validation / exit

- [x] Touched compaction + tool suites green (98/0).
- [x] New regression tests (amnesia-notice TV-1, S3 replay generalization).
- [x] XDG backed up; restart via `webctl.sh restart`; no new enablement flag.
- [x] Live fetch-back: deployed on test then main; misreport gone, mid-task resume
      works, bloat-driven compaction loop removed (via the upstream redirection fix).
