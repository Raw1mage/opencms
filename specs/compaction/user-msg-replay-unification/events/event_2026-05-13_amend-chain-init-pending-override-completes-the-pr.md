---
date: 2026-05-13
summary: "amend: chain-init-pending override completes the proposed dynamic decision"
---

# amend: chain-init-pending override completes the proposed dynamic decision

# Amend — 2026-05-13: chain-init-pending override in shouldInjectContinue

The original spec proposed (2026-05-09) replacing the static
`INJECT_CONTINUE[observed]` table with "let the helper decide — replay if
there's an unanswered user msg, fall back to Continue if not". The
replayUnansweredUserMessage helper was implemented and wired into multiple
call sites, but the **static table was preserved at the entry of
shouldInjectContinue** — for the false-default cases (rebind /
continuation-invalidated / provider-switched / stall-recovery / manual),
Continue injection was unconditionally blocked.

## Why the table couldn't simply be flipped

The 2026-04-27 infinite-loop bug class (regression test
`compaction.regression-2026-04-27.test.ts`) hinged on a phantom-rebind
detection at processor.ts:707 firing every round → each firing wrote a
rebind compaction → injected synthetic Continue → AI looped on autonomous
continuation. The static `INJECT_CONTINUE[rebind]=false` was the defence
of last resort even if cooldown / state-driven evaluation both missed.

Flipping the table back to `true` re-enables that bug class if the
upstream structural defence (state-driven evaluation, INV-7 time-of-write
anchor identity) ever has a hole.

## The new signal: PendingInjectionStore.peek

Phase A-C+ of `specs/session/rebind-procedure-revision` introduced
`Continuation.run` as the single dispatch point for chain-affecting
events. Genuinely user-initiated rebind / account-switch / etc. flow
through Continuation.run and write a `PendingInjectionStore` mark with
`chainInit=true`. **The 2026-04-27 phantom-detect path does NOT route
through Continuation.run** (it's a processor-internal mid-stream
comparison artifact), so it writes NO mark.

This lets shouldInjectContinue distinguish:
- Real user-initiated rebind → mark present → safe to fall through to
  user-msg-post-anchor check
- Phantom rebind (2026-04-27 bug class) → no mark → preserve table-of-
  last-resort defence

## Implementation

`compaction.ts:2410` (shouldInjectContinue) — when
`INJECT_CONTINUE[observed]=false`, instead of immediate `return false`,
peek PendingInjectionStore for a `chainInit=true` mark. If present,
fall through; if absent, preserve legacy behaviour.

The user-msg-post-anchor check (existing) then decides:
- User msg present → false (replay handled it; don't double-inject)
- No user msg → true (real user-initiated event with no replay → AI continues)

## Commit

main `d0b47fe99` — feat(compaction): chain-init-pending override for shouldInjectContinue (A1/rev4)

## Test matrix

10 new tests in `compaction.user-msg-replay-rev2.test.ts` covering the
full PendingInjection × INJECT_CONTINUE × user-msg-post-anchor cube.
Plus existing 2026-04-27 regression test still passes (phantom path
has no mark → defence preserved).

## Sibling reference

Cross-recorded as rev4 in `specs/session/rebind-procedure-revision/events/`.
The two specs are now interlocked: rebind-procedure-revision's chain-init
machinery is what makes user-msg-replay-unification's dynamic decision
safely implementable.

## Companion: appendRecentEvent re-ordering inside publishCompactedAndResetChain

Same commit, separate concern: `void Session.appendRecentEvent(...)` now
fires BEFORE `await Continuation.run(...)` inside
publishCompactedAndResetChain. Otherwise the fire-and-forget appendRecent
loses to outer awaiters that observe ring state right after the
SessionCompaction.run() promise resolves. Closes a pre-existing test
flake in `compaction-replay-deep.test.ts:289`.

## Status

- [x] Override implemented + 10 unit tests
- [x] Existing 2026-04-27 regression test still passes
- [x] Existing user-msg-replay tests still pass (164 across 9 files)
- [x] tsgo --noEmit clean
- [x] Commit on main `d0b47fe99`
- [ ] Daemon restart + live verification (user-initiated rebind → AI proceeds)
- [ ] Optional follow-up: amend the static `INJECT_CONTINUE` table comments to reflect that the table is now "default policy with chain-init override" rather than "structural defence of last resort"
