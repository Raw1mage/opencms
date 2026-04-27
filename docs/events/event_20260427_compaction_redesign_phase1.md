# Event: compaction-redesign phase 1 — Memory module skeleton

## Phase

1 — Memory module skeleton + Storage path (per `specs/compaction-redesign/tasks.md`).

## Done

- 1.1 Created `packages/opencode/src/session/memory.ts` housing the `Memory`
  namespace.
- 1.2 Types `SessionMemory`, `TurnSummary`, `FileEntry`, `ActionEntry`
  defined per `data-schema.json`. Forward-compat normalize layer included
  so blobs missing `lastCompactedAt` / `rawTailBudget` from earlier daemon
  versions still load cleanly.
- 1.3 `Memory.read(sid)` reads from new path `session_memory/<sid>`;
  on miss, projects legacy `SharedContext.Space` + rebind-checkpoint disk
  file into the new shape and lazy-writes once. Per AGENTS.md rule 1, the
  fallback emits `memory.legacy_fallback_read` log line. DD-3 pattern.
- 1.4 `Memory.write(sid, mem)` writes to `session_memory/<sid>`. Includes
  sessionID guard (throws on mismatch — INV-5 idempotency depends on it).
- 1.5 `Memory.appendTurnSummary` appends, bumps version, persists. Caller
  is the runloop exit handler we'll wire in phase 3.
- 1.6 `Memory.markCompacted` writes `lastCompactedAt`. Cooldown source-of-truth
  per DD-7; phase 7 will delete the separate `cooldownState` Map.
- 1.7 Unit test `memory.test.ts` (9 cases) covers: empty session,
  new-path-preferred-over-legacy, legacy SharedContext projection,
  legacy checkpoint projection, both-legacies-merged, write guard,
  appendTurnSummary accumulation, markCompacted overwrite, forward-compat
  shape normalization.

## Key decisions

- **Legacy bridge as TurnSummary** — `SharedContext.goal + discoveries +
  currentState` are projected as a single synthesized TurnSummary entry
  with `userMessageId = "<legacy-bridge-shared-context>"`, not dropped. The
  regex-extracted shape doesn't carry true narrative quality, but
  preserving it during migration is better than losing the only context
  the legacy session had. Once a session captures its first real
  TurnSummary post-deployment, it grows real narrative on top of the bridge.
- **`turnSummaries` array shape** stayed exactly as data-schema.json
  prescribed; no deviations to flag.
- **`rawTailBudget` default 5** picked from data-schema.json default;
  later phases (raw-tail executor, phase 5.3) consume it.

## Validation

- `bun test packages/opencode/src/session/memory.test.ts` → 9 pass / 0 fail
- `bun test packages/opencode/src/session/compaction.test.ts` → 9 pass /
  0 fail (existing tests unaffected, INV-1..INV-9 not yet stressed since
  no consumer has been wired)
- `bunx tsc --noEmit -p packages/opencode/tsconfig.json` → clean for the
  new files (no errors related to memory.ts / memory.test.ts)
- `plan-sync.ts specs/compaction-redesign/` → clean (no drift)

## Drift

None. tasks.md / spec.md / data-schema.json / design.md remain authoritative.

## Remaining (phase 2 onward)

- Phase 2: render functions (`renderForLLM`, `renderForHuman`).
- Phase 3: TurnSummary capture at runloop exit (the first user-visible
  behaviour change — sessions begin accumulating real narrative).
- Phase 4: single entry point `SessionCompaction.run` with KIND_CHAIN
  table.
- Phases 5-12: executors, runloop wiring, flag deletion, anchor unification,
  shim layer, UI, validation, deprecation removal.

Phase 1 is foundational; nothing in production reads from `Memory` yet, so
this phase has zero behavioural blast radius. Phase 3 is when external
behaviour first changes (sessions start writing TurnSummary entries).

## Files changed

- `packages/opencode/src/session/memory.ts` — new (270 lines)
- `packages/opencode/src/session/memory.test.ts` — new (200 lines)
- `specs/compaction-redesign/tasks.md` — phase 1 boxes checked
