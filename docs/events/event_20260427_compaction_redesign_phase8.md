# Event: compaction-redesign phase 8 — anchor unification (DD-8)

## Phase

8 — collapse the dual representation of "where history truncates" into
a single canonical source: the `summary: true` assistant message in the
session message stream. The rebind-checkpoint disk file's
`lastMessageId` field becomes optional / legacy-only.

## Done

- 8.1 Made `lastMessageId` optional on `RebindCheckpoint` interface and
  the `saveCheckpointAfterCompaction` / `saveRebindCheckpoint` parameter
  surface. New writes (prompt.ts runloop's checkpoint-save call) no
  longer pass it.
- 8.2 New private helper `findRebindBoundaryIndex(messages,
  checkpointLastMessageId?)` walks `messages` backward and returns the
  most recent `summary: true` assistant message's index as the boundary.
  Falls through to checkpoint's `lastMessageId` only when no in-stream
  anchor exists. Returns `-1` when neither source resolves.
  `applyRebindCheckpoint` rewritten to use this helper.
- 8.3 Backward-compat verified: the two pre-existing tests
  ("applies a safe rebind checkpoint", "rebuilds replay as checkpoint
  prefix plus raw tail steps") both pass without modification — their
  message streams have no anchor, so the helper falls through to the
  legacy `lastMessageId` lookup.
- 8.4 Two new tests in `compaction.test.ts`:
  - "phase 8: applyRebindCheckpoint locates boundary via summary anchor
    in stream" — message stream has a `summary: true` anchor; checkpoint
    has no `lastMessageId`; helper finds the anchor and produces the
    correct synthetic-summary + post-anchor messages.
  - "phase 8: applyRebindCheckpoint with no anchor + no lastMessageId
    returns boundary_missing" — neither source resolves; helper returns
    `boundary_missing`.

## Drift / cleanup of unrelated flake

While running the full suite I noticed `compaction-run.test.ts`
"replay-tail over-budget" intermittently timing out at 5000ms when
synthesizing many large messages. Rewrote it to use a small fake model
(8K context) with smaller test data — same coverage, deterministic in
under 100ms.

## Validation

- `bun test compaction.test.ts` → 7 → 9 pass / 0 fail (added 2 cases).
- All 6 compaction-redesign test files: **77 pass / 0 fail / 252
  expectations**.
- `bunx tsc --noEmit -p packages/opencode/tsconfig.json` → clean for
  modified files.
- No regressions in legacy rebind-checkpoint tests.

## Observable behaviour change

For new sessions: rebind-checkpoint disk files no longer contain a
`lastMessageId` field. If the daemon crashes mid-session and restart
happens, recovery scans the message stream for the most recent summary
anchor (which the new compaction path always writes). This is the
canonical DD-8 behaviour.

For sessions that compacted under pre-phase-8 code: their checkpoint
files still carry `lastMessageId`. On restart, the message stream is
walked first (anchor scan); if an anchor exists, it wins (new
compactions overwrite the previous boundary). If only the legacy
checkpoint exists, `lastMessageId` is honoured. No data loss.

## Out of scope

- The disk file itself is retained; phase 9's deprecation shim layer
  may eventually consolidate it into a single Memory artifact (DD-3
  envisages persisting Memory + Anchor in the same place, but that's
  a future cleanup, not a behavioural change).
- Manual smoke (kill daemon mid-session, restart, verify) deferred to
  phase 11 acceptance gate.

## Files changed

- `packages/opencode/src/session/compaction.ts` — RebindCheckpoint
  interface, save helpers, applyRebindCheckpoint refactor +
  findRebindBoundaryIndex.
- `packages/opencode/src/session/prompt.ts` — saveRebindCheckpoint
  call site stops passing `lastMessageId`.
- `packages/opencode/src/session/compaction.test.ts` — 2 new test
  cases for DD-8.
- `packages/opencode/src/session/compaction-run.test.ts` — drive-by
  fix to over-budget test for determinism.
- `specs/compaction-redesign/tasks.md` — phase 8 boxes checked.

## Remaining

- Phase 9 deprecation shim layer (informational; current shims are
  thin enough already).
- Phase 10 UI consumption (renderForHuman in session-list preview).
- Phase 11 manual smoke + spec architecture update (architecture.md
  already reflects post-phase-8 state).
- Phase 12 next-release deprecation removal.
