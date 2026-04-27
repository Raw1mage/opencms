# Event: compaction-redesign phase 6 — state-driven runloop wiring

## Phase

6 — `deriveObservedCondition` + new compaction path wired into the
runloop. **Behavioural change phase**: the runloop now consults
state-driven evaluation as its primary compaction trigger, falling
through to the legacy branches only when the new chain exhausts
(transitional bridge until phase 7).

## Done

- 6.1 `deriveObservedCondition(input)` in `prompt.ts` — pure-ish function
  that reads only observable state (Memory cooldown, pinned identity,
  message-stream tail anchor, lastFinished tokens) and returns
  `Observed | null`. Priority order: subagent skip → cooldown gate →
  manual → provider-switched → rebind → overflow → cache-aware → null.
- 6.1b `findMostRecentAnchor(msgs)` helper — walks msgs backward,
  returns the first assistant message with `summary === true`. Anchor
  carries providerId / accountId for state-driven rebind detection
  (INV-7).
- 6.2/6.3/6.4 Wire-in: new `deriveObservedCondition` + `SessionCompaction.run`
  call inserted BEFORE the legacy `task?.type === "compaction-request"`
  branch in the runloop. When `observed` non-null → call run(); when run
  returns `"continue"` → `continue` the loop (skip legacy branches);
  when run returns `"stop"` → fall through to legacy branches
  (transitional, kept until phase 7+ removes legacy).
- 6.2b Transitional flag drain: `consumeRebindCompaction(sessionID)` is
  called at the top of the new evaluation block to drain the legacy
  flag. This prevents the legacy `consumeRebindCompaction` branch from
  re-firing in a later iteration after the new path has already written
  the anchor for the same condition.
- 6.5 Single `run()` per iteration is structurally enforced: the new
  path invokes run() at most once (only when observed is non-null), and
  if run returns "continue" the loop short-circuits. The cooldown gate
  inside run() prevents the same iteration from firing twice (e.g. if a
  caller invoked run() manually elsewhere).
- 6.6 Unit tests `prompt.observed-condition.test.ts` (14 cases): null
  baseline, subagent skip, cooldown skip, manual priority over all
  others, provider-switched priority over rebind, no-anchor → no rebind,
  overflow, cache-aware, identity drift > token pressure. Plus 3
  `findMostRecentAnchor` cases.

## Behavioural impact

This is the **second behaviour-change phase** (after phase 3 which only
wrote Memory). The runloop now:

1. Drains the legacy `pendingRebindCompaction` flag (transitional).
2. Calls `deriveObservedCondition` to read current state.
3. If non-null observed → calls new `SessionCompaction.run` entry.
4. On `"continue"` → skips legacy branches, proceeds to next iteration.
5. On `"stop"` → falls through to legacy branches (compaction-request /
   rebind / overflow), preserving old behaviour for paths the new chain
   doesn't yet cover (notably empty-Memory `/compact` that needs
   LLM-agent fallback — phase 6+ extracts that).

For sessions that have accumulated TurnSummary content (after at least
one runloop exit since phase 3 deployment), the new path supersedes
the legacy on all common conditions: manual `/compact` becomes free,
overflow becomes free, rebind becomes free.

For empty-Memory edge cases (cold sessions, first-turn sessions), the
schema executor falls back to `SharedContext.snapshot`. If even that's
empty, the chain exhausts and legacy `process()` (LLM-agent path) takes
over. So no regression.

## Rollback safety

To roll back phase 6 alone: remove the `deriveObservedCondition` call
block in `prompt.ts` (between `// ── compaction-redesign phase 6` and
`// ── legacy compaction branches`). Legacy branches resume their
pre-phase-6 role. No data corruption pathway because phase 1-5 work
remains additive (Memory written but never read in legacy branches).

## Validation

- `bun test prompt.observed-condition.test.ts` → 14 pass / 0 fail
- `bun test prompt.turn-summary-capture.test.ts` → 7 pass / 0 fail
- `bun test memory.test.ts` → 16 pass / 0 fail
- `bun test compaction-run.test.ts` → 23 pass / 0 fail
- `bun test compaction.test.ts` → 9 pass / 0 fail
- **Combined: 69 tests pass across 5 files**
- `bunx tsc --noEmit` clean for new files
- Pre-existing failures in unrelated files unchanged (5 fails on
  session/index.test.ts and similar — predate phase 1)

## Drift

- plan-sync.ts will continue to warn that `*.test.ts` files lack spec
  references — log-and-continue per §16.3.
- The transitional bridge (legacy branches kept) is intentional and
  documented in handoff.md execution contract; phase 7 + LLM-agent
  extraction removes them together.

## Files changed

- `packages/opencode/src/session/prompt.ts` — `deriveObservedCondition`
  + `findMostRecentAnchor` helpers; new state-driven block inserted
  before legacy compaction-request branch in runloop
- `packages/opencode/src/session/prompt.observed-condition.test.ts` —
  new (14 cases + 3 findMostRecentAnchor cases)
- `specs/compaction-redesign/tasks.md` — phase 6 boxes (6.2/6.3/6.4
  marked in-progress as "wired with transitional bridge"; phase 7
  finalizes by deleting legacy)

## Remaining (phase 7+)

Phase 7 deletes `pendingRebindCompaction` flag, `markRebindCompaction`,
`consumeRebindCompaction`, the in-memory `cooldownState` Map, the
processor.ts:734 `markRebindCompaction` call, and the legacy
compaction-request / rebind / overflow branches in prompt.ts. Plus
extracts the LLM-agent core out of `process()` and into
`tryLlmAgent`. After that, the transitional bridge is gone and run()
is the only compaction entry point.
