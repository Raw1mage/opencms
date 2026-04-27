# Event: compaction-redesign phase 4 — single entry point + tables

## Phase

4 — `SessionCompaction.run` entry point with `KIND_CHAIN` /
`INJECT_CONTINUE` tables and `Cooldown` helper. The structural backbone of
the redesign.

## Done

- 4.1 Types `Observed`, `KindName`, `RunInput`, `RunResult` defined per
  `data-schema.json`.
- 4.2 `KIND_CHAIN` table literal: 7 observed values × cost-monotonic kind
  arrays. Frozen with `Object.freeze` to make accidental mutation a
  TypeError.
- 4.3 `INJECT_CONTINUE` table literal: 7 observed values × boolean. R-6
  expressed as data — `rebind` / `continuation-invalidated` /
  `provider-switched` / `manual` all map to `false`. The 2026-04-27
  infinite loop bug is structurally extinct here: there's no code path
  that injects Continue on rebind because the table value is `false`,
  full stop.
- 4.4 `Cooldown.shouldThrottle(sid, currentRound, threshold)`. DD-7
  source-of-truth: reads `Memory.lastCompactedAt`. Default threshold 4
  rounds (matches existing REBIND_COOLDOWN_ROUNDS).
- 4.5 `SessionCompaction.run(input)` walks the chain, writes anchor on
  first ok kind, calls `Memory.markCompacted` on success. Every kind
  transition emits `compaction.kind_attempted` log line per AGENTS.md
  rule 1. Cooldown short-circuit returns `"continue"` (not `"stop"`) so
  the runloop continues without LLM call.
- 4.5b Test injection: the anchor write is routed through a private
  `_writeAnchor` indirection. `__test__.setAnchorWriter()` lets tests
  replace it without standing up Session/Bus/Storage stack.
  Production wraps `compactWithSharedContext` (DD-8 unifies it with
  rebind-checkpoint in phase 8).
- 4.5c `manual` + `intent: "rich"` (DD-10): chain becomes `[llm-agent]`
  only. Tested.
- 4.6/4.7/4.8 Unit tests cover R-6, R-4, R-5 acceptance plus 15 other
  scenarios (chain monotonicity, INJECT_CONTINUE values, Cooldown
  variants, throttle gating, --rich override, markCompacted call).

## Phase 5 carry-over

Phase 4 implements the SHELL. Schema / replay-tail / low-cost-server /
llm-agent executors are stubbed (return `false` immediately). Phase 5
fills them in:
- 5.2 Schema executor → `SharedContext.snapshot` text
- 5.3 Replay-tail executor → last N raw rounds from message stream
- 5.4 Low-cost-server executor → wraps existing `tryPluginCompaction`
- 5.5 LLM-agent executor → wraps existing legacy `process()` LLM path

Until phase 5 lands, `run({observed: "manual"})` only succeeds via the
narrative path (memory non-empty); empty-memory manual `/compact` falls
through narrative + low-cost-server stub + llm-agent stub → returns
`"stop"` → caller falls back to legacy `process()` path. Acceptable
intermediate state because phase 6 hasn't wired runloop callers yet.

## Validation

- `bun test packages/opencode/src/session/compaction-run.test.ts` →
  18 pass / 0 fail (54 expectations)
- `bun test packages/opencode/src/session/compaction.test.ts` →
  9 pass / 0 fail (existing tests preserved)
- `bun test packages/opencode/src/session/memory.test.ts` →
  16 pass / 0 fail (phase 1+2 preserved)
- `bun test packages/opencode/src/session/prompt.turn-summary-capture.test.ts` →
  7 pass / 0 fail (phase 3 preserved)
- Combined: **50 tests pass across 4 files** for the compaction-redesign work
- Pre-existing failures in unrelated test files (`session/index.test.ts`,
  `session/usage-cost.test.ts`, `session/command.test.ts`) are not
  regressions: same files have 23 fails on `git stash` of my changes
  (these failures predate phase 1).
- `bunx tsc --noEmit` clean for new files.

## Drift

`plan-sync.ts` will note `compaction-run.test.ts` as code-only (no spec
field referenced) — log-and-continue per §16.3 decision tree.

## Files changed

- `packages/opencode/src/session/compaction.ts` — Memory import; types
  `Observed` / `KindName` / `RunInput` / `RunResult`; tables `KIND_CHAIN`
  / `INJECT_CONTINUE`; `Cooldown` namespace; `tryNarrative` /
  `tryUnimplementedKind` / `tryKind` helpers; `resolveActiveModel`
  helper; `run` entry point; `_writeAnchor` indirection; `__test__`
  accessor with `setAnchorWriter` / `resetAnchorWriter`.
- `packages/opencode/src/session/compaction-run.test.ts` — new (18 cases).
- `specs/compaction-redesign/tasks.md` — phase 4 boxes checked.

## Remaining

Phases 5-12. Phase 5 fills in the four stub executors so `run` can
actually reach paid kinds when needed.
