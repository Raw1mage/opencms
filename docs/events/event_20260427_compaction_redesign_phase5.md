# Event: compaction-redesign phase 5 — executors

## Phase

5 — Schema / Replay-tail / Low-cost-server executor implementations.
LLM-agent executor remains a stub awaiting phase 6+ runloop refactor.

## Done

- 5.1 Narrative — already implemented in phase 4 (`tryNarrative`).
- 5.2 `trySchema(input, model)` — calls `SharedContext.snapshot`,
  budget-checks ≤ 30% of model context, returns ok with the legacy
  regex-extracted text when present and within budget.
- 5.3 `tryReplayTail(input, model)` — reads `Memory.rawTailBudget`
  (default 5), reads `Session.messages`, takes trailing
  `2 * budget` messages, serializes role-prefixed text as plain
  `User: ...\n\nAssistant: ...` form. Budget-checked. Used as crash
  recovery fallback per DD-2.
- 5.4 `tryLowCostServer(input, model)` — triggers `session.compact`
  plugin hook independently of legacy `tryPluginCompaction`. Lifted the
  `buildConversationItemsForPlugin` helper into a shared form so phase 9
  can collapse both call sites onto one helper.
- 5.5 `tryLlmAgent(input, model)` — kept as stub (returns `false` with
  reason "not yet implemented"). Phase 6 wires the runloop, after which
  the legacy `process()` LLM-round logic can be extracted here.

## Why LLM-agent stayed a stub

The legacy `process()` does anchor-write + Continue injection internally,
duplicating run()'s contract. Lifting just the LLM-round core requires
splitting `process()` into the LLM machinery + the anchor-write tail,
then deleting the tail. That refactor is large and tangles with phase 6
runloop wiring. Easier to land both together.

Until then, callers exhausting the chain (e.g. manual `/compact` on an
empty-Memory session with no codex plugin handler) return `"stop"` from
run() and the legacy `process()` path remains in effect for those cases.

## Validation

- `bun test compaction-run.test.ts` → 23 pass / 0 fail (added 5 phase-5
  cases on top of phase 4's 18)
- `bun test compaction.test.ts` → 9 pass / 0 fail
- `bun test memory.test.ts` → 16 pass / 0 fail
- `bun test prompt.turn-summary-capture.test.ts` → 7 pass / 0 fail
- Combined: 55 tests pass across 4 files
- `bunx tsc --noEmit -p packages/opencode/tsconfig.json` clean for
  modified files

## Drift

- plan-sync.ts will warn that `compaction-run.test.ts` lacks spec
  references — log-and-continue per §16.3 (test files are
  code-only, expected).

## Files changed

- `packages/opencode/src/session/compaction.ts` — added
  `trySchema` / `tryReplayTail` / `tryLowCostServer` / `tryLlmAgent` +
  `buildConversationItemsForPlugin`; updated `tryKind` to dispatch to all
  five.
- `packages/opencode/src/session/compaction-run.test.ts` — added 5
  executor tests (schema happy path, replay-tail happy path, low-cost
  happy path + plugin-null fallback, replay-tail over-budget).
- `specs/compaction-redesign/tasks.md` — phase 5 boxes checked (5.5
  marked in-progress with rationale).

## Remaining (phase 6+)

Phase 6 wires the three runloop call sites in `prompt.ts` to call
`SessionCompaction.run()` instead of the legacy paths. Phase 6 + 7 +
LLM-agent executor finalization land together.
