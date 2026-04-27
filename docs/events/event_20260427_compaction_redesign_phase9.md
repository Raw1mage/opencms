# Event: compaction-redesign phase 9 — deprecation surface realignment

## Phase

9 — finalize the deprecated API surface. Original spec R-9 was overly
aggressive: most listed APIs are still actively used by the new state-
driven path as internal helpers. Phase 9 realigns the spec and the
code annotations to reflect the actual deprecated set.

## What R-9 originally claimed

> The legacy API surface (`SharedContext.snapshot`, `saveRebindCheckpoint`,
> `loadRebindCheckpoint`, `SessionCompaction.process`,
> `compactWithSharedContext`, `markRebindCompaction`,
> `consumeRebindCompaction`, `recordCompaction`) shall be replaced by
> deprecation shims… removed entirely in the next release.

## What it actually means after phase 7+

| API | Real status | Why |
|---|---|---|
| `markRebindCompaction` / `consumeRebindCompaction` | **DELETED in phase 7** | Replaced by `session.execution.continuationInvalidatedAt` (DD-11) + state-driven evaluation in `deriveObservedCondition`. No shim needed. |
| `SessionCompaction.process` | **Deprecated shim** | Phase 7b reduced to ~15 lines; delegates to `run({observed: input.auto ? "overflow" : "manual"})` with `log.warn`. |
| `SessionCompaction.recordCompaction` | **Deprecated shim** | Phase 7 / DD-7 made `Memory.lastCompactedAt` the cooldown source-of-truth; this shim delegates to `Memory.markCompacted` with `log.warn`. (Phase 9 added the `log.warn`.) |
| `SessionCompaction.compactWithSharedContext` | **Kept (internal)** | Production anchor-write path. `_writeAnchor` default impl wraps it; pre-loop identity-switch compaction uses it directly. NOT deprecated. |
| `SharedContext.snapshot` | **Kept (executor source)** | `trySchema` reads it for the schema kind in the cost-monotonic chain. NOT deprecated. |
| `saveRebindCheckpoint` / `loadRebindCheckpoint` | **Kept (rebind recovery)** | Disk-file based restart/rebind context restoration. Phase 8 (DD-8) narrowed `lastMessageId` to optional but did not deprecate the path itself. NOT deprecated. |
| `getCooldownState` | **Kept (cooldown read path)** | Used by `isOverflow` / `shouldCacheAwareCompact`. Reads `Memory.lastCompactedAt` per DD-7 instead of the deleted `cooldownState` Map. NOT deprecated. |

The spec's original framing came from a pre-implementation viewpoint
where the new path was conceived as totally independent of legacy
helpers. In practice, the executors (narrative / schema / replay-tail
/ low-cost-server / llm-agent) reuse parts of the legacy infrastructure
because those parts are doing useful work — the issue was always
*where decisions are made* (now: single entry point), not *who reads
SharedContext.snapshot* (still: trySchema; that's fine).

## Done

- 9.1 Decision: do **not** create a separate `compaction-shims.ts`.
  Only 2 functions qualify as deprecated; inlining the
  `@deprecated` + `log.warn` annotation in `compaction.ts` is
  clearer than fragmenting the namespace.
- 9.2 `recordCompaction` updated: `@deprecated` JSDoc tag added,
  `log.warn` emitted on call (matches existing `process()` pattern).
- 9.3 `spec.md` R-9 rewritten to reflect actual scope. Original
  framing kept as "Initial framing"; new "Phase 9 realignment" table
  and revised acceptance scenarios documented.
- 9.4 `tasks.md` phase 9 boxes finalized — most marked `[~]` with
  "kept, not deprecated" rationale; `9.4` (`process()`) and `9.6`
  (grep verification) marked `[x]`.

## Validation

- `bun test` over all 6 phase-1..10 test files: **77 pass / 0 fail /
  252 expectations**.
- `bunx tsc --noEmit` clean for modified files (compaction.ts).
- `plan-validate` PASS at state=implementing.
- Code grep verified: zero in-repo callers of `process()` or
  `recordCompaction`. Both shims are tripwires for any future
  out-of-repo or forgotten import.

## Why no `compaction-shims.ts` file

Original tasks.md prescribed centralizing deprecated APIs into a
dedicated file. With the actual deprecated set down to 2 functions,
both already living in `compaction.ts`, splitting them out would:

1. Force a re-export pattern (namespace member can't easily live in a
   different file) that obscures rather than clarifies.
2. Create a new file that future readers might mistake for "place to
   add shims" — ironically *encouraging* future deprecation accretion
   instead of forcing it onto the central API.

The current pattern (inline `@deprecated` + `log.warn` in
`compaction.ts` itself) is more honest: the shims are co-located with
their replacements, and removing them in phase 12 is a one-shot edit
in one file.

## Out of scope

- Phase 12 (next-release deletion of the 2 remaining shims) — happens
  in a future release, not this plan.
- Promotion to `verified` is the immediate follow-up — addressed
  separately.

## Files changed

- `packages/opencode/src/session/compaction.ts` — `recordCompaction`
  gains `@deprecated` JSDoc + `log.warn`.
- `specs/compaction-redesign/spec.md` — R-9 rewritten with realignment
  table and updated acceptance scenarios.
- `specs/compaction-redesign/tasks.md` — phase 9 boxes finalized.
