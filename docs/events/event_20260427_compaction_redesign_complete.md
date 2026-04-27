# Event: compaction-redesign complete (phases 1-7 + 6b + 7b)

## Status

The compaction subsystem redesign is **functionally complete** and
**deployed in beta**. Phases 1-7 + 6b + 7b have all landed. Phases
8-12 (anchor unification cleanup, deprecation shim documentation, UI
consumption, manual smoke validation, next-release deprecation
removal) are deferred — they don't block the system from running, and
the cleanup work is incremental against a now-stable foundation.

## What changed (one-line summary)

Compaction is now driven by a single entry point reading observable
session state. The 2026-04-27 infinite-loop bug class is structurally
extinct, manual `/compact` is mostly free, and ~270 lines of legacy
branching logic were deleted from the runloop.

## Phase commit ledger

| Phase | Commit | Effect |
|---|---|---|
| 1 Memory module skeleton | `61c9fdf44` | New file; zero behaviour change |
| 2 Render functions | `e9ffe498a` | renderForLLM / renderForHuman; zero behaviour change |
| 3 TurnSummary capture | `99a48cba6` | Runloop exit appends TurnSummary to Memory |
| 4 run() + KIND_CHAIN tables | `e070350d7` | Single entry point; zero behaviour change (no caller yet) |
| 5 schema/replay-tail/low-cost executors | `32366e98f` | Three executors filled in; LLM-agent stub |
| 6 state-driven runloop wiring | `4affb5174` | Behaviour change: new path is primary; legacy is fallback bridge |
| 7.5 regression test | `28866cfac` | 2026-04-27 bug class pinned by 3 structural defenses |
| spec extension | `1bf92f739` | DD-11 + DD-12 + S8/S9 + R-10/R-11 + phase 6b/7b in spec docs |
| 6b DD-11 + DD-12 implementation | `a6c53ac08` | continuation-invalidated state-driven; subagent path open |
| 7b LLM-agent extraction | `c90f7a640` | runLlmCompactionAgent helper; tryLlmAgent wired |
| 7 legacy plumbing deletion | `b13066c1f` | -270 / +106 lines: prompt.ts branches gone, flag plumbing gone |

## Bug classes structurally eliminated

- **2026-04-27 runloop infinite loop**
  - INJECT_CONTINUE['rebind'] = false in a frozen table literal
  - INV-3 / R-6 enforced at the data layer; no code path can take
    observed=rebind and emit a synthetic Continue
  - Verified by `compaction.regression-2026-04-27.test.ts` (3 cases)

- **2026-04-27 manual /compact double-fire**
  - Cooldown universally applied — Memory.lastCompactedAt is the
    single source of truth (DD-7); `cooldownState` Map deleted
  - Manual /compact now defaults to free narrative path (most cases
    write zero API calls)

- **Phantom rebind flag**
  - `pendingRebindCompaction` Set deleted entirely
  - State-driven detection compares pinned identity to most recent
    Anchor's identity; no stale-flag possibility

- **Subagent silent swallow**
  - Discovered during user review (mid-implementation)
  - Phase 6b DD-12: subagents now use the same state-driven path
  - The pre-DD-12 phase 6 code was actively suppressing subagent
    rotation signals; that's fixed.

## Test coverage

- `compaction.test.ts` — 7 cases (legacy cooldown + checkpoint, rewritten
  to use Memory mocks)
- `compaction-run.test.ts` — 23 cases (run() entry, KIND_CHAIN structure,
  Cooldown helper, executors)
- `memory.test.ts` — 16 cases (read/write/append/mark/render variants)
- `prompt.turn-summary-capture.test.ts` — 7 cases (capture wiring)
- `prompt.observed-condition.test.ts` — 19 cases (state-driven derivation
  including DD-11 + DD-12)
- `compaction.regression-2026-04-27.test.ts` — 3 cases (structural
  defenses)

**Total: 75 tests, 245 expectations, all pass.**

`bunx tsc --noEmit` clean for all modified session/* files.

## What's still to do (deferred)

- **Phase 8 — Anchor unification (DD-8)**: collapse the rebind-checkpoint
  disk file into the unified Memory artifact. Currently the disk file
  remains readable for restart recovery. Cosmetic cleanup, not
  blocking.
- **Phase 9 — Deprecation shim layer**: `SessionCompaction.process`
  reduced to a thin shim that delegates to `run()`; logged with WARN.
  `tryPluginCompaction` deleted entirely (zero callers).
  `compactWithSharedContext` retained as the production anchor-write
  helper. Full shim removal is a phase 12 concern (next release).
- **Phase 10 — UI consumption of `renderForHuman`**: needs
  frontend-side work to swap session-list preview's snapshot fetch
  for renderForHuman. Out of scope for the session-layer redesign.
- **Phase 11 — Manual smoke validation**: rebuild + restart daemon,
  exercise `/compact` and account rotation in real sessions, verify
  zero codex API calls during narrative-only paths.
- **Phase 12 — Deprecation removal**: next release deletes the
  shim layer entirely.

## Files touched (final inventory)

### New
- `packages/opencode/src/session/memory.ts` (~530 lines)
- `packages/opencode/src/session/memory.test.ts` (~315 lines)
- `packages/opencode/src/session/compaction-run.test.ts` (~485 lines)
- `packages/opencode/src/session/compaction.regression-2026-04-27.test.ts` (~155 lines)
- `packages/opencode/src/session/prompt.observed-condition.test.ts` (~270 lines)
- `packages/opencode/src/session/prompt.turn-summary-capture.test.ts` (~165 lines)

### Modified
- `packages/opencode/src/session/compaction.ts` (~+450 / -350 net)
- `packages/opencode/src/session/prompt.ts` (~+200 / -290 net)
- `packages/opencode/src/session/processor.ts` (-1 markRebindCompaction call; drive-by typo fix)
- `packages/opencode/src/session/index.ts` (+continuationInvalidatedAt schema field; +markContinuationInvalidated helper)
- `specs/architecture.md` (+Compaction Subsystem section)
- `specs/compaction-redesign/*` (full plan-builder package)

### Deleted (logical)
- `pendingRebindCompaction` Set + `markRebindCompaction` + `consumeRebindCompaction` (compaction.ts)
- `cooldownState` Map (compaction.ts)
- `tryPluginCompaction` private helper (compaction.ts; superseded by tryLowCostServer)
- Three legacy compaction branches in prompt.ts (compaction-request task / continuation-rebind / overflow)
- `processor.ts:734` markRebindCompaction call
- Two legacy "rebind cooldown" tests in compaction.test.ts (APIs gone)

## Final guardrails

- **plan-validate** passes at state=implementing (13 artifacts).
- **plan-sync** clean (no untracked drift).
- **No regressions** in any compaction-redesign test file. Pre-existing
  failures in `session/index.test.ts` and similar are unrelated to
  this work and were present on `git stash` of all our changes.

## Recommended user action

1. **Manual smoke** before merging to `cms`:
   - Rebuild + restart the daemon in the beta worktree
   - Exercise `/compact` on a populated session — verify zero codex
     API calls (codex usage logs)
   - Trigger an account rotation mid-session — verify exactly one
     rebind Anchor produced (debug.log)
   - Send a continuation-invalidated event (codex side) — verify
     continuation-invalidated path produces an Anchor and signal
     goes naturally stale next iteration
2. **Optional**: implement phase 8 (anchor unification) before merge
   if cleanup is preferred over speed.
3. **Merge**: fetch-back beta/compaction-redesign through
   test/compaction-redesign → main, then promote spec to `verified`
   and eventually `living` per beta-workflow §5.
