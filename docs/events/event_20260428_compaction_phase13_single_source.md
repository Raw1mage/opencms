# 2026-04-28 — compaction-redesign Phase 13: single-source-of-truth consolidation

## Why

Phase 9 of compaction-redesign declared "7→3 conceptual collapse" but
left three implementation-layer artefacts intact:

1. `SessionMemory` journal file at Storage key `session_memory/<sid>`
2. `RebindCheckpoint` disk file at `~/.local/state/opencode/rebind-checkpoint-<sid>.json`
3. `SharedContext.snapshot()` regex extractor for legacy text fallback

All three encoded the same thing — "what already happened in this
session" — written in three different shapes to three different places.
User feedback (2026-04-28): the conceptual collapse should also be the
implementation collapse. The messages stream is the single source of
truth; everything else is a derivation of it.

## What changed (in commit order on `test/compaction-redesign`)

1. **`9ff11e42b`** — cooldown anchor-based + schema kind retired
   - `Cooldown.shouldThrottle(sid)` reads most-recent anchor message's
     `time.created` (30s window). Drops `Memory.lastCompactedAt`
     dependency, `currentRound` parameter, the round-vs-timestamp
     dual-path logic from 532f9edaa.
   - `trySchema` and `"schema"` removed from every `KIND_CHAIN` entry.
     Fresh sessions stay empty; narrative falls through to next kind.

2. **`cf4535b24`** — rebind via stream-anchor only (Phase 13.2-A)
   - New helpers: `findMostRecentAnchorIndex`, `applyStreamAnchorRebind`.
   - 4 callsites switched: `step==1` rebind block, parent-context
     priority 1 for subagents, pre-loop provider-switch context
     resolution, post-iteration `saveRebindCheckpoint` write.

3. **`4ba54a3ee`** — RebindCheckpoint disk-file surface deleted (Phase 13.2-B)
   - Removed: `RebindCheckpoint` interface, `saveRebindCheckpoint`,
     `loadRebindCheckpoint`, `applyRebindCheckpoint`,
     `deleteRebindCheckpoint`, `pruneStaleCheckpoints`,
     `saveCheckpointAfterCompaction`, `findRebindBoundaryIndex`,
     `getRebindCheckpointPath`, `_lastCheckpointRound` Map,
     `REBIND_BUDGET_TOKEN_THRESHOLD`, `REBIND_CHECKPOINT_MAX_AGE_MS`,
     `shouldRebindBudgetCompact`, `SessionDeletedEvent` Bus listener,
     5-second startup timer that pruned stale files.
   - Net: −413 lines.

4. **`d603b810b`** — state-driven overflow uses msgs estimate (hotfix)
   - Pre-existing bug: state-driven evaluator anchored on previous LLM
     call's `lastFinished.tokens.input`. When a single iteration
     appended bulk tool-output text (e.g. `system-manager_read_subsession`
     dumping ~170K), the next round's prompt was much bigger than
     `lastFinished` reported, overflow check missed, request went out,
     provider rejected.
   - Fix: pass `max(estimateMsgsTokenCount(msgs), lastFinished.tokens.input)`
     to `isOverflow` / `shouldCacheAwareCompact`. Catches bloated tool
     outputs before the request goes out.

5. **`c84ecb309`** — SharedContext.snapshot retirement (Phase 13.3 full)
   - 3 remaining call sites switched / deleted: `idleCompaction` body
     routes through `run({observed: "idle"})`; subagent parent-context
     priority 2 deleted entirely (priority 1 stream-anchor + priority 3
     recent-history covers the gap); pre-loop provider-switch first
     attempt removed (stream-anchor only).
   - Deleted: `snapshot`, `persistSnapshot`, `snapshotDiff`,
     `formatForInjection`, `formatSnapshot` from `shared-context.ts`.
     `SharedContext.Space` + `get` / `updateFromTurn` / `mergeFrom`
     retained (file/action workspace, separate concept).

6. **`c8d42eb81`** — Memory render-time from messages stream (Phase 13.1)
   - `Memory.read(sid, messages?)` derives `SessionMemory` from the
     stream. Most recent anchor → first "rolled-up" turnSummary entry.
     Post-anchor finished assistants → individual turnSummary entries.
     Aux fields (`fileIndex`, `actionLog`) from `SharedContext.Space`.
   - Removed: `Memory.write`, `Memory.appendTurnSummary`,
     `Memory.markCompacted`, `captureTurnSummaryOnExit` (the runloop
     write path), `Memory.legacyCheckpointPath`,
     `Memory.readLegacyCheckpoint`, `recordCompaction` shim,
     `getCooldownState` shim. isOverflow / shouldCacheAwareCompact
     internal cooldown checks deleted (single gate is upstream).
   - Net: −482 lines across 7 files.

## Behavior verification (live)

Daemon restarted at 17:22:17 on 2026-04-28 with `9ff11e42b` in place.
Within minutes, real workload triggered the new path:

```
18:12:27.409 loop:state_driven_compaction observed=overflow step=7
18:12:27.577 compaction.started observed=overflow step=7
18:12:27.579 compaction.kind_attempted kind=narrative succeeded=true
18:12:27.728 compaction.completed kind=narrative step=7
```

320ms wall-time, kind=narrative one-shot, zero API calls. The
state-driven evaluator (with `d603b810b`'s msgs-estimate fix)
correctly detected the upcoming-prompt overflow before the LLM call
went out; cooldown (anchor-based, with `9ff11e42b`'s 30s window)
allowed it because no recent anchor existed; narrative kind compressed
the post-anchor turn summaries within the 50K target cap and wrote a
new anchor.

## Net effect

- ~890 lines removed across compaction.ts, prompt.ts, memory.ts,
  shared-context.ts, plus their test files.
- 3 disk-file persistence surfaces collapsed to 0 (only the messages
  stream persists).
- 1 cooldown logic path (was 2: round-based + timestamp fallback).
- 1 compaction recovery path (was 3: in-memory state, disk file,
  legacy regex extractor).
- Residual disk artefacts on existing user state dirs are silently
  ignored — never read, never written, never deleted (user backup
  safety; AGENTS.md "never rm tracked files" extended to user state).

## What's still left

- **Type-2 overflow** — single-tool-output bigger than model context.
  No compaction strategy can compress one chunk that's already too
  large. Solution: tool self-chunking (each variable-size tool knows
  `outputBudget` and pre-splits semantically) + chunked-digest
  protocol (round-aligned slice points, AI-collaborative digest of
  each chunk). Tracked as a separate plan-builder spec, to be opened
  after Phase 13 fetch-back to main.
- Manual smoke (compaction-redesign §11.3 / §11.4): user-driven
  validation of account-rotation single-anchor and `/compact`
  zero-API behaviour on a real session.
- Pending-compaction-telemetry stuck-state observation (`compactionResult: pending`
  from a hung round) — separate cleanup, not blocking the fetch-back.

## Branch state

`test/compaction-redesign` carries 8 commits ahead of main:

```
c8d42eb81 refactor(session): Memory render-time from messages stream (Phase 13.1)
c84ecb309 refactor(session): retire SharedContext.snapshot regex extractor (Phase 13.3 full)
4ba54a3ee refactor(session): delete RebindCheckpoint disk-file surface (Phase 13.2-B)
cf4535b24 refactor(session): rebind via stream-anchor only (Phase 13.2-A)
d603b810b fix(session): state-driven overflow uses msgs estimate
9ff11e42b fix(session): cooldown anchor-based + delete schema kind (Phase 13)
f6a99d801 fix(session): rebind token-refresh + double-phase compaction (≤50K target)
532f9edaa fix(session): Cooldown.shouldThrottle adds timestamp fallback for cross-runloop boundaries
```

Tests: 193 pass / 5 pre-existing failures (Session.getUsage,
prepareCommandPrompt, session execution identity — all unrelated).

After user-driven smoke validation, fetch-back to `main`.
