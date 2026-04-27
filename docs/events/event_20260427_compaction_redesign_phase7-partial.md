# Event: compaction-redesign phase 7 — partial (regression test landed; deletion blocked)

## Phase

7 — partial. Only 7.5 (regression test) lands. Tasks 7.1–7.4 are
blocked pending two design decisions the original plan didn't capture
(DD-11 + LLM-agent extraction). Surfaced via §16.3 sync decision tree
as a "drift requires extend mode" signal.

## Done

- 7.5 `compaction.regression-2026-04-27.test.ts` — three cases that
  pin the structural defenses against the 2026-04-27 bug:
  1. **INV-3 / R-6**: `run({observed: "rebind"})` writes anchor with
     `auto: false`. No synthetic Continue injection regardless of
     state. Asserts the bug's amplifier is structurally extinct.
  2. **INV-2 / cooldown**: real rotation produces exactly one anchor;
     immediate retry within 4-round cooldown is throttled (returns
     `"continue"` without writing); past cooldown second rotation
     produces a second anchor (one-per-condition, not one-per-attempt).
  3. **Structural defense**: `INJECT_CONTINUE` is `Object.freeze`'d so
     accidental mutation is a TypeError, not a silent regression.

## Blocked

### 7.1 — needs DD-11: state-driven continuation-invalidated signal

`pendingRebindCompaction` Set still has one legitimate caller besides
processor.ts: the `ContinuationInvalidatedEvent` Bus subscription at
`compaction.ts:36`. Codex provider fires this event when `previous_response_id`
is rejected. The flag was the cross-layer signal: codex layer marks,
runloop next iteration consumes.

DD-1 says state-driven evaluation must replace flags. For continuation-invalidated
specifically, the signal needs to live in observable session state, not
module memory. Two candidate designs (DD-11 to be added):

- **A**: persistent flag in `session.execution.continuationInvalidatedAt`
  (timestamp). `deriveObservedCondition` returns "continuation-invalidated"
  when this timestamp is newer than the most recent Anchor's `createdAt`.
  Anchor must carry `createdAt` (currently doesn't reliably). `run()` on
  success leaves the flag in place; cooldown comparison handles "stale".
- **B**: codex layer writes a synthetic `continuation-invalidated` part
  to the message stream (similar to compaction-request). Tail walker
  picks it up. No new session.execution field, but adds noise to the
  message stream.

DD-11 needs user input. Until decided, leave the legacy flag mechanism
in place for ContinuationInvalidatedEvent only.

### 7.2 — depends on 7.1 (cannot delete processor.ts:734 call without flag's other use cases addressed)

### 7.3 — needs LLM-agent extraction (`tryLlmAgent` real implementation)

`cooldownState` is read by `isOverflow` and `shouldCacheAwareCompact`,
both still called by the legacy compaction-request task branch in
prompt.ts (line ~1665). To delete the Map cleanly, the legacy branch
must be deleted; for that to be safe, `tryLlmAgent` must implement the
LLM-agent kind so `run({observed: "manual"})` handles empty-Memory
sessions without falling through to legacy.

Extracting `tryLlmAgent` requires splitting `SessionCompaction.process()`
into the LLM-round core + the anchor-write tail. That is a substantial
refactor (~200 lines moved across boundaries) and entangles with
existing `tryPluginCompaction` ordering. Worth a dedicated phase
slot, not bundled into phase 7.

Recommend: introduce phase 7b "LLM-agent extraction" before 7.1–7.3.

### 7.4 — depends on 7.1–7.3

## Validation

- New test: `compaction.regression-2026-04-27.test.ts` → 3 pass / 0 fail
- All phase 1-6 + this regression: 72 pass / 0 fail across 6 files
- `bunx tsc --noEmit` clean
- No legacy plumbing was modified — phase 6's transitional bridge
  remains intact

## Drift

- `tasks.md` updated to mark 7.1–7.4 as `[!]` blocked with the inline
  reason. plan-builder §16.3 says "blocked → must include reason
  inline"; here the reason is "BLOCKED on DD-11" / "BLOCKED on
  LLM-agent extraction".
- §16.3 decision tree maps this to: drift adds new requirements
  (DD-11) → stop and run `extend` mode. Recommended next action:
  `plan-promote --mode extend --reason "add DD-11: continuation-invalidated state-driven signal; add phase 7b for LLM-agent extraction"`.

## Files changed

- `packages/opencode/src/session/compaction.regression-2026-04-27.test.ts` —
  new (3 cases)
- `specs/compaction-redesign/tasks.md` — 7.1–7.4 marked `[!]` blocked;
  7.5 marked `[x]`

## Recommended next steps

1. **Manual smoke** of the current beta build (rebuild + restart daemon
   in the beta worktree). Validate that phases 1-6 + 7.5 don't regress
   anything in real session usage. Phase 6 introduced the biggest
   behavioural change (state-driven primary path); a smoke pass here is
   strongly advised before phase 7+ destabilization.
2. **plan-promote --mode extend** to add DD-11 and a new phase 7b
   covering LLM-agent extraction.
3. **Resume implementation** through phase 7b → 7 → 8 → 9 → 10 → 11.

The current state is a clean stable checkpoint:
- 72 tests pass
- Phase 1-5 are dormant additions (no behavioural impact)
- Phase 3 + 6 are the only behaviour-change phases, both reversible
  by deleting their wire-in code
- The 2026-04-27 bug class is structurally extinct (proven by
  regression test + INJECT_CONTINUE table-freeze + state-driven anchor
  identity comparison)
