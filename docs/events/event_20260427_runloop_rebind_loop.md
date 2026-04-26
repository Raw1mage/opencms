# Event: runloop rebind-compaction infinite loop

## Symptom

Session `ses_23a4ed76effev4mhtJ3YhMK0iS` (codex / gpt-5.5) generated 408
messages in roughly 3 minutes after the user idled the conversation. Each
"round" repeated the same shape:

1. assistant `agent=compaction summary=true` with a 719-char snapshot.
2. assistant `agent=build` LLM round, `tokens.input ≈ 28000-30000`, finish
   = `tool-calls`.
3. user message with synthetic text `Continue if you have next steps, or
   stop and ask for clarification if you are unsure how to proceed.`

`needsCompaction` reported `false` every round — overflow was *not* the
trigger. Daemon log was emitting

    WARN  continuation invalidated, compaction scheduled for next round
    INFO  loop:rebind_compaction_triggered source=continuation_invalidation
    syslog.session  post-stream account changed  newAccountId=codex-subscription-yeatsraw-thesmart-cc

every ~5 seconds. `previousAccountId` was a different codex account each
round; `newAccountId` was always the same one — i.e. rotation looked
identical from the outside but the comparator kept flagging it as a
"silent switch".

## Root cause

`packages/opencode/src/session/processor.ts:707` watches for mid-stream
account-switch by comparing
`input.assistantMessage.accountId !== streamInput.accountId` after
`LLM.stream()` returns and, on mismatch, calls
`SessionCompaction.markRebindCompaction(sessionID)`.

The two values were initialized in `prompt.ts` from different sources:

- `streamInput.accountId = effectiveAccountId` (read from
  `session.execution.accountId`, the pinned identity from the previous
  rotation, plus user-message fallback).
- `assistantMessage.accountId = lastUser.model.accountId` (frozen at
  user-message time, never updated when rotation changed the active
  account).

After any single rotation, those two diverged permanently. Every
subsequent round entered `LLM.stream()` with `streamInput.accountId =
yeatsraw` (pinned), no internal rotation needed, returned with
`streamInput.accountId = yeatsraw`, and the comparator still saw
`assistantMessage.accountId = officer` (original lastUser) → fired
`markRebindCompaction()`.

That alone would be a noisy false positive. The bug compounded into an
infinite loop because the rebind path in
`packages/opencode/src/session/prompt.ts:1532` called
`compactWithSharedContext({ ..., auto: true })`, and `compaction.ts:906-930`
treats `auto: true` as "this compaction is a continuation request",
injecting a synthetic "Continue if you have next steps..." user message
on top of the session. That synthetic message kept the runloop alive
through the next iteration, which fired another spurious "account
changed" comparison, which set the pending flag again, which the next
round consumed, which compacted, which injected another Continue. The
runloop never reached a natural stop.

`consumeRebindCompaction()` had no cooldown gate, unlike its siblings
`isOverflow()` and `shouldCacheAwareCompact()`, so the per-session
cooldown buffer that protects overflow compaction did nothing here.

## Three-layer fix

### Layer 1 — root cause (`prompt.ts`)

When the runloop creates the new assistant message and the new
`SessionProcessor` for this round, it now uses `effectiveAccountId`
instead of `lastUser.model.accountId`. Both values now share a single
source of truth (`session.execution.accountId` with `lastUser` fallback)
so the post-stream comparator no longer sees a phantom switch.

    -          accountId: lastUser.model.accountId,
    +          accountId: effectiveAccountId,
             ...
             SessionProcessor.create({
    -          accountId: lastUser.model.accountId,
    +          accountId: effectiveAccountId,
             })

### Layer 2 — amplifier (`prompt.ts`)

The rebind path now passes `auto: false` to `compactWithSharedContext`.
A rebind compaction is a maintenance compaction triggered by a
continuation-invalidation signal; the runloop continues naturally if the
prior assistant finished with `tool-calls`. Injecting a synthetic
"Continue" user message turned compaction into autonomous
continuation — and was a critical multiplier on layer 1.

    await SessionCompaction.compactWithSharedContext({
      sessionID, snapshot: snap, model,
    -  auto: true,
    +  auto: false,
    })

The overflow path (`prompt.ts:1608`) intentionally keeps `auto: true`:
overflow compaction is gated by `isOverflow()` cooldown and overflow
genuinely interrupts an in-flight run, so the synthetic Continue is
correct there.

### Layer 3 — brake (`compaction.ts`)

`consumeRebindCompaction()` now accepts an optional `currentRound`
argument. When provided, it consults the same `cooldownState` Map used
by `isOverflow`/`shouldCacheAwareCompact` and refuses to consume the
flag if `currentRound - lastCompactionRound < REBIND_COOLDOWN_ROUNDS`
(default 4). The flag stays pending across the cooldown window so a
post-cooldown round can still honor it. Legacy no-arg callers retain
the original one-shot behaviour.

The runloop call site at `prompt.ts:1512` was updated to pass `step` as
`currentRound`.

## Tests

`packages/opencode/src/session/compaction.test.ts` gains two cases:

- `rebind compaction respects cooldown when fired repeatedly` — same
  round and rounds within cooldown both return `false`; round past
  cooldown returns `true` once and the flag is consumed.
- `rebind compaction without currentRound bypasses cooldown (legacy
  path)` — backwards-compat guard for callers that intentionally want
  unconditional consume.

## Files changed

- `packages/opencode/src/session/prompt.ts` (3 lines effective)
- `packages/opencode/src/session/compaction.ts` (cooldown gate + rebind
  cooldown constant)
- `packages/opencode/src/session/compaction.test.ts` (2 new cases)

## Out of scope / follow-ups

- The pre-existing `l.warn(...)` typo at
  `packages/opencode/src/session/processor.ts:391` (introduced
  2026-04-15 by `102f3548c`) was left alone — unrelated to this loop.
- This fix does not change *whether* `markRebindCompaction()` is
  called from inside `processor.ts` on a genuine mid-stream switch;
  legitimate rotations still write the rebind anchor. Layer 1 only
  prevents phantom switches that were never real switches.
- LLM.stream's internal rotation behaviour is unchanged.

## Related

- `event_20260418_codex_rotation_hotfix.md` — the rotation pinning that
  this fix relies on.
- `event_20260419_runloop_autorun_gate.md` — earlier work on stopping
  unintended runloop continuation pumps.
