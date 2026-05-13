# compaction_simplification — plan execution event log (2026-05-14)

Plan ID: `compaction_simplification` (private; lives under `/plans/`)

## Summary

Collapsed the compaction subsystem's 5-anchor-kind taxonomy onto a
3-strategy executor-role taxonomy (`local` / `ai_free` / `ai_paid`),
retired the rev5 sustainability watermark and the legacy
`shared_context/<sessionID>` sidecar writer flow, introduced an
explicit anchor lineage chain via `replacesAnchorId`, replaced the
absolute 5K hybrid-upgrade floor with a 20% context-relative gate,
and renamed `compactWithSharedContext` → `writeAnchorFromBody` so the
function name stops claiming behavior it no longer has.

## Commits (in landing order on `main`)

- `3f89aed19` test: merge beta/compaction-simplification (T1+T2a+T4+T8)
  - T1 — Anchor / AnchorWorkspace / ToolRecallEntry / CompactionStrategy
    type definitions (purely additive)
  - T2a — retire `tryNarrativeLegacy`, rename
    `tryNarrativeRedactedDialog` → `tryLocalRedactedDialog`
  - T4 — replace 5K absolute upgrade floor with 20% context-relative
    threshold (`localToAiThresholdRatio`)
  - T8 — retire rev5 sustainability watermark
    (`measureSustainabilityWatermark`, `forceContractiveCompaction`,
    `sustainabilityRatio` tweak, full test file)
- `00c7416e7` test: merge beta/compaction-simplification-t3 — rename
  remote strategies in event metadata
  (`low-cost-server` → `ai_free`, `llm-agent` → `ai_paid`) with
  back-compat readers for legacy event-log entries
- `95c4ae499` test: merge beta/compaction-simplification-t2b — retire
  `replay-tail` as a Strategy. Tail is the messages that naturally
  follow the anchor in SQLite, not a compaction kind. Deleted
  `tryReplayTail`, removed `"replay-tail"` from KindName / AnchorKind
  / KIND_CHAIN. Back-compat: amnesia-notice still accepts legacy
  `"replay-tail"` event-log entries.
- `f9634d41b` test: merge beta/compaction-simplification-t5
  (T5+T6+T7+T9)
  - T5 — `SharedContext.extractWorkspaceBatch` + `toAnchorWorkspace`
    helpers (batch extraction over a flat message range)
  - T6 — retire `SharedContext.updateFromTurn` / `mergeFrom` call
    sites; `Memory.read` derives `fileIndex` + `actionLog` via the
    batch extractor instead of the persisted Space sidecar
  - T7 — `replacesAnchorId` on every new anchor write +
    `Memory.Hybrid.walkAnchorLineage` newest-first chain walker
    with legacy chronological fallback
  - T9 — rename `compactWithSharedContext` → `writeAnchorFromBody`,
    old name kept as `@deprecated` alias for one cycle

## Workflow

T1+T2a+T4+T8 and T3 and T2b were each developed on their own
`beta/compaction-simplification[-...]` worktree branch, validated on
a fresh `test/...` branch off `main`, then fast-forwarded into
`main`. T5+T6+T7+T9 were stacked on a single beta branch and
fetch-backed as one merge after the final task.

`/plans/compaction_simplification/` remains private (gitignored per
the `plans-are-private` rule). Only `/specs/compaction/README.md`,
`/specs/architecture.md`, and this event log are tracked.

## Verification

- Per-task tests are bundled in each commit:
  - 5 new tests in `compaction-workspace.test.ts` (T5)
  - 7 new tests in `compaction-lineage.test.ts` (T7)
  - existing kind-enum assertions updated across
    `compaction-run.test.ts`, `compaction.test.ts`,
    `anchor-sanitizer.test.ts`, `compaction-telemetry.test.ts`,
    `amnesia-notice.test.ts`
  - `compaction.sustainability-watermark.test.ts` deleted (T8)
- Broader test-sweep delta (`bun test packages/opencode/src/session/
  packages/opencode/test/`): each merge to `main` introduced 0 new
  failures versus the baseline at start of the work; two pre-existing
  failures (`kindChainFor` tests with stale expectations and one
  flaky `RebindEpoch` rate-limit test) were carried forward.

## Deferred / out of scope

- T10 verification clause "Tests" was fulfilled inline rather than as
  a discrete commit — each refactor brought its own tests.
- T11 Docs sweep — this event log + targeted `architecture.md` and
  `specs/compaction/README.md` edits. Deeper rewrite of
  `compaction-redesign` archived spec was not in scope.
- The deprecated `compactWithSharedContext` alias (T9) and the
  unused function definitions in `shared-context.ts`
  (`updateFromTurn`, `mergeFrom`, `save`, `get`) are retained for one
  cycle; cleanup tracked separately.

## Rollback strategy

Each merge commit is a `--no-ff` merge so a single `git revert -m 1
<merge-sha>` reverses one increment without touching the others.
Per-strategy back-compat readers (event-log normalizer, lineage
chronological fallback) mean a partial revert remains functional on
mixed-vintage data.
