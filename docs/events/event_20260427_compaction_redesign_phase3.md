# Event: compaction-redesign phase 3 — TurnSummary capture at runloop exit

## Phase

3 — TurnSummary capture (DD-2). First behaviour-change phase: sessions
begin accumulating real narrative content from production runloops.

## Done

- 3.1 Added `captureTurnSummaryOnExit(...)` call at `prompt.ts` runloop
  exit site (immediately before `log.info("exiting loop")` and `break`).
  Call site receives `sessionID`, `lastAssistant`, `lastUser`, `msgs`,
  `step` — finds the lastAssistant's parts via msgs, extracts text,
  builds TurnSummary, calls `Memory.appendTurnSummary`.
- 3.2 Fire-and-forget pattern: the call does not `await`. Errors from
  `Memory.appendTurnSummary` are caught by an inline `.catch` that logs a
  WARN (`memory.turn_summary_append_failed`). Runloop's `break` proceeds
  immediately; INV-6 (durability before next boundary) still holds because
  Storage.write is in flight before any subsequent runloop invocation.
- 3.3 Three graceful-skip conditions:
  - `lastAssistant` undefined → return early
  - lastAssistant.id not found in `msgs` (defensive) → return early
  - text-parts collapse to empty after trim → return early
  All paths skip silently per DD-2 (mid-run / error exits should not
  pollute Memory with low-quality stubs).
- 3.4 Unit test `prompt.turn-summary-capture.test.ts` (7 cases):
  extractFinalAssistantText concatenation order, missing/empty parts,
  happy-path append, undefined lastAssistant skip, no-text-part skip,
  fire-and-forget rejection swallowed without throwing.

## Behavioural impact

This is the first phase that **changes runtime behaviour** in production:

- Every runloop exit (finish ≠ tool-calls) now writes a SessionMemory
  blob to Storage key `session_memory/<sid>`.
- For new sessions, Memory accumulates real TurnSummary narrative.
- For existing sessions still on legacy SharedContext, the first runloop
  exit triggers the lazy-migration path inside `Memory.read` (per
  phase 1's DD-3 fallback) before the new TurnSummary is appended.
- No reader consumes Memory yet (phase 4 wires `SessionCompaction.run`).
  Until then, Memory is a write-only artifact: visible in Storage,
  ignored by the rest of the system. This is intentional — it lets
  Memory accumulate one or two turns of real narrative before any
  consumer needs to use it, smoothing the rollout.

## Rollback safety

If phase 3 needs to be rolled back independently, remove the single
`captureTurnSummaryOnExit(...)` call line and the helper functions.
Storage blobs already written remain readable by future reinstatements
of the feature. No data corruption pathway.

## Validation

- `bun test packages/opencode/src/session/prompt.turn-summary-capture.test.ts` → 7 pass / 0 fail
- `bun test packages/opencode/src/session/memory.test.ts` → 16 pass / 0 fail
- `bun test packages/opencode/src/session/compaction.test.ts` → 9 pass / 0 fail
- Combined: 32 tests pass across 3 files
- `bunx tsc --noEmit -p packages/opencode/tsconfig.json` → clean for new files
- `plan-sync.ts specs/compaction-redesign/` → clean (will run before commit)

## Drift

None planned. plan-sync may flag the new test file as code-only drift
(same as phase 2's memory.test.ts); per §16.3 decision tree that is
log-and-continue.

## Remaining (phase 4 onward)

Phase 4 introduces `SessionCompaction.run` entry point with KIND_CHAIN
table. That's when Memory becomes a read source: the Narrative executor
will call `Memory.renderForLLM(sid)`, accept its output as Anchor body,
and skip the API entirely.

Until phase 4 lands, manual `/compact` still goes through the existing
hot-fix path (snapshot priority 0 from commit 196ac0bff) — which already
prefers SharedContext snapshot over plugin/LLM agent. So the user-visible
"manual /compact mostly free" win is partially active today via the
hotfix; phase 4 cuts it over to Memory-driven narrative for higher
fidelity.

## Files changed

- `packages/opencode/src/session/prompt.ts` — Memory import, helper
  functions `captureTurnSummaryOnExit` + `extractFinalAssistantText`
  exported, capture call wired into runloop exit branch
- `packages/opencode/src/session/prompt.turn-summary-capture.test.ts` — new (7 cases)
- `specs/compaction-redesign/tasks.md` — phase 3 boxes (3.4 marked
  in-progress with rationale; manual smoke deferred to phase 11)
