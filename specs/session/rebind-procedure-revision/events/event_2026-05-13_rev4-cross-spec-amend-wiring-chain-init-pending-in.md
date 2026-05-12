---
date: 2026-05-13
summary: "rev4: cross-spec amend wiring chain-init-pending into user-msg-replay-unification"
---

# rev4: cross-spec amend wiring chain-init-pending into user-msg-replay-unification

# Revision 4 — cross-spec wiring with compaction/user-msg-replay-unification

The `INJECT_CONTINUE` static table's false-default for rebind /
continuation-invalidated / provider-switched / stall-recovery / manual
was suppressing synthetic-Continue injection for genuinely user-
initiated chain-break events. Symptom: after admin-PATCH account-switch
+ compaction completion, AI would silently stop instead of resuming
the user's pending task. The user observed this directly in 2026-05-12
live testing.

The fix lives in `compaction.ts:shouldInjectContinue` (sibling spec
`compaction/user-msg-replay-unification`'s territory), but it uses
**this spec's PendingInjectionStore** as the new distinguishing signal:

- `INJECT_CONTINUE[observed]=true`  → table is the floor (unchanged)
- `INJECT_CONTINUE[observed]=false` → peek PendingInjectionStore
    - chainInit pending mark  → real user-initiated event → fall through
                                to user-msg-post-anchor check
    - no mark                 → preserve 2026-04-27 defence-of-last-resort

The signal is correct because:
- Real user-initiated rebind goes through `Continuation.run` (Phase B/C
  rewire) and writes a `PendingInjectionStore.mark({ chainInit: true, … })`
- The 2026-04-27 phantom-detect path (processor.ts:707 mid-stream
  account-comparison artifact) is processor-internal and does NOT
  route through Continuation.run, so it writes no mark

This makes the chain-init-pending the **structural distinguisher**
between user-initiated and phantom rebind events, exactly the
distinction that was missing in the original 2026-04-27 fix design.

## How this connects this spec's contribution

The multi-dimensional rebind classifier (theory.md §0) now also serves
as a **provenance signal** for downstream consumers like
shouldInjectContinue: any chain-affecting event that flowed through
`Continuation.run` is provably "real" in the sense that some
event-source layer (admin PATCH, account rotation, compaction) emitted
it deliberately, not by accident.

This adds a new dimension to the spec's value proposition beyond just
"notify the AI of chain reset": **the protocol is also an audit trail
that downstream code can read to make safer decisions**.

## Commit reference

main `d0b47fe99` — see commit message for details.

## Tests

10 new tests in `compaction.user-msg-replay-rev2.test.ts`, all passing.
164 tests across 9 affected files all green. tsgo clean.

## Live verification pending

Requires daemon restart. Expected post-restart sequence:
1. User does admin-PATCH account-switch (e.g. to officer account)
2. session.rebind event with chainBreakClass=SS-break
3. chain.init.injected (PendingInjectionStore.mark with chainInit=true)
4. Compaction fires (observed=rebind, post-PATCH context still heavy)
5. publishCompactedAndResetChain → appendRecentEvent → Continuation.run
6. shouldInjectContinue: INJECT_CONTINUE[rebind]=false BUT
   PendingInjectionStore has chainInit=true → fall through → no user msg
   post-anchor → returns true → injectContinueAfterAnchor fires
7. AI receives synthetic Continue → resumes work
8. (vs pre-fix: step 6 returns false at the first gate → AI stops)

## Status

- [x] Amend implemented + tested
- [x] Cross-recorded in both specs
- [x] Commit `d0b47fe99` on main
- [ ] Daemon restart + live verification
