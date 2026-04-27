# Design: compaction-redesign

## Context

The compaction subsystem evolved organically across several releases:
`SharedContext` was added first as a per-turn scratchpad; `rebind-checkpoint`
was layered on top to survive daemon restart; `compaction summary message`
was added to mark history truncation points in the message stream;
`pendingRebindCompaction` was added to handle mid-stream account switches;
`compaction-request` part was added to let `/compact` enqueue work;
`cooldownState` was added late to throttle the previous mechanisms.

Each addition was correct in isolation. Together they form seven concepts
overlapping in ill-defined ways, with three trigger sites in `prompt.ts`
each making its own decisions about kind selection, anchor writing,
synthetic-Continue injection, and cooldown recording. The 2026-04-27
incidents (runloop infinite loop, double compaction) were both products of
this fragmentation.

This redesign collapses the seven concepts to three (`Memory`, `Anchor`,
`Cooldown` — possibly two if `Cooldown` is derivable from `Anchor` reads),
routes every compaction through one entry point with state-driven
evaluation, and replaces regex-extracted slot-filling memory with `TurnSummary`
narrative captured at runloop exit.

## Goals / Non-Goals

### Goals

- **Conceptual surface ≤ 3.** No more than three named concepts in the
  public API of the compaction subsystem.
- **One entry point.** Every compaction execution path goes through
  `SessionCompaction.run`.
- **State-driven, not signal-driven.** The runloop evaluates current
  observable state each iteration; no flags persist across iterations.
- **Cost-monotonic kind chain.** The decision logic is a single ordered
  table literal: free narrative → free schema → free replay tail → low-cost
  server-side → LLM agent.
- **Narrative memory.** `TurnSummary` (AI's natural turn-end self-summary)
  is the primary memory content; regex-extracted file/action metadata
  becomes auxiliary only.
- **Bug classes structurally eliminated.** The two 2026-04-27 incidents
  cannot recur in the new shape because the conditions that produced them
  (stale flags, scattered decision logic, accidental synthetic-Continue
  injection) are not representable.

### Non-Goals

- New compaction provider / engine.
- Changing codex `/responses/compact` quota cost.
- New UI surfaces (only existing UI gains `renderForHuman` consumption).
- Cross-session memory transfer beyond current subagent inheritance.
- Refactoring the runloop or processor structures beyond the one capture
  site for `TurnSummary`.

## Decisions

DD-1 through DD-6 are documented in full in `proposal.md`. Summary here:

- **DD-1** Schedule concept eliminated. State-driven evaluation each iteration.
  `pendingRebindCompaction` deleted.
- **DD-2** `TurnSummary` captured at runloop exit only. Mid-run crash recovery
  uses raw tail (last N rounds), not partial summaries.
- **DD-3** Migration: writes go to new path; reads fall back to legacy on
  miss; first read of a legacy session triggers a one-time projected write.
- **DD-4** New file: `packages/opencode/src/session/memory.ts`.
- **DD-5** Two independent render functions: `renderForLLM`, `renderForHuman`.
- **DD-6** Deprecation shim lifetime: 1 release. Next release removes legacy
  API entirely.

Additional design-level decisions documented below:

### DD-7 — Cooldown lives in Memory, not in a separate Map

`cooldownState` (current `Map<sid, lastCompactionRound>`) is collapsed into
`Memory`. Each successful compaction updates `Memory.lastCompactedAt =
{round, timestamp}`. `Cooldown.shouldThrottle(sid, currentRound, threshold)`
reads this field. The separate `cooldownState` Map is removed.

**Why**: avoids two persistence paths for the same datum; "did we compact
recently" is a property of the Memory, not a separate ledger.

**Implication**: tests that previously called `recordCompaction(sid, n)`
directly now call `Memory.markCompacted(sid, {round: n})`.

### DD-8 — Anchor is a single message-stream artifact

The current dual representation of "where history truncates" (compaction
summary message in message stream + `lastMessageId` in rebind checkpoint
file) is unified. The single representation is the compaction summary
assistant message in the message stream. The rebind-checkpoint file's
`lastMessageId` field is dropped from the on-disk format; recovery code
reads the most recent `summary:true` assistant message from the session
stream to find the boundary.

**Why**: `filterCompacted` already truncates at the most recent compaction
part; making the rebind path read the same source eliminates the second
representation.

**Implication**: rebind-checkpoint file shrinks to `{sessionID, snapshot,
timestamp}`. The `lastMessageId` field is kept readable on legacy files
but ignored.

### DD-9 — Single entry-point signature

```typescript
SessionCompaction.run(input: {
  sessionID: string
  observed: "overflow" | "cache-aware" | "rebind" | "continuation-invalidated"
            | "provider-switched" | "manual" | "idle"
  step: number
  intent?: "default" | "rich"        // only meaningful for observed=manual
}): Promise<"continue" | "stop">
```

Internally, `run` walks a kind-chain table indexed by `observed`. Each chain
step is `(kind, conditions to attempt) → result`. Entries in the table are
data, not branching code.

### DD-11 — Continuation-invalidated state-driven signal (added 2026-04-27 mid-implementation)

**Discovery context**: phase 7 (delete `pendingRebindCompaction` flag)
revealed one legitimate caller still using it — the
`ContinuationInvalidatedEvent` Bus subscription at `compaction.ts:36`,
fired by codex provider when the server rejects `previous_response_id`.
DD-1 demands flags go away; this signal needs a state-driven
replacement.

**Decision**: **Option A** — persist `continuationInvalidatedAt` (epoch
ms) on `session.execution`. The codex Bus listener writes the timestamp;
`deriveObservedCondition` returns `"continuation-invalidated"` when the
timestamp is **newer than the most recent Anchor's `time.created`**.
Once `run({observed: "continuation-invalidated"})` writes a new Anchor,
the next iteration's comparison naturally goes stale and the condition
no longer fires — cooldown becomes implicit through anchor-recency
comparison, no separate flag-clear step.

**Why Option A over Option B (synthetic message-stream part)**:
- Keeps the message stream clean (no synthetic noise visible in UI /
  audit views).
- Reuses existing `session.execution` persistence (already durable
  across daemon restart).
- Option B would require introducing a new part type or repurposing
  `compaction-request`, both entangling with message-stream schema work
  scoped out of this plan.

**Implications**:
- `session.execution` schema gains `continuationInvalidatedAt: number |
  null`.
- Anchor messages must carry `time.created` reliably (already true via
  current `compactWithSharedContext`).
- `deriveObservedCondition` priority list gains "continuation-invalidated"
  between "manual" and "provider-switched":
  `manual > continuation-invalidated > provider-switched > rebind > overflow > cache-aware`.
- The `compaction.ts:36` Bus listener changes from
  `markRebindCompaction(sid)` to writing the timestamp on
  session.execution.

**Tests**:
- `deriveObservedCondition` returns "continuation-invalidated" when
  session.execution.continuationInvalidatedAt > lastAnchor.time.created.
- After successful run, next iteration's deriveObservedCondition does
  not return it again (anchor.time.created has advanced past the
  timestamp).

### DD-12 — Subagent compaction policy (added 2026-04-27 mid-implementation)

**Discovery context**: user asked "what happens when subagent triggers
compaction mid-work?" during phase 7 review. Phase 6's
`if (input.parentID) return null` guard makes subagents skip the new
state-driven path entirely; phase 6's transitional flag drain at the
top of every iteration also silently swallows mid-rotation /
continuation-invalidated signals on subagent sessions. Net effect:
subagent rotation still updates session.execution pin, but never
produces a fresh Anchor. The 2026-04-27 bug class is technically still
representable on subagents.

**Decision**: **Subagents use the same state-driven path as parents**
for `rebind`, `continuation-invalidated`, `provider-switched`,
`overflow`, `cache-aware`. Subagent compaction writes to the
**subagent's own message stream**. The parentID-skip guard in
`deriveObservedCondition` is **removed**. The only observed value
subagents do NOT trigger is `"manual"` (subagents have no UI surface).

**Rationale**:
- The 2026-04-27 bug class affects subagents identically; structural
  defenses must apply.
- Writing to subagent's own stream preserves existing subagent
  isolation (subagent has its own session, its own message stream).
- Subagent inheritance of parent context via `Memory.read(parentID)`
  remains a separate concern (already handled by phase 1's lazy
  fallback).

**Implications**:
- Drop `if (input.parentID) return null` from `deriveObservedCondition`
  (or narrow to `if (parentID && observed === "manual") return null`).
- Drop the `if (!session.parentID)` guards inside legacy rebind /
  overflow branches once they are deleted in phase 7+.
- Subagent's `Memory` accumulates TurnSummary as already wired in phase
  3; DD-12 gives it a reader path (state-driven new rebind → narrative
  kind → renderForLLM).
- sequence.json gains S8 (subagent compaction).

**Risk**: subagent compaction during dispatch may interleave with
parent-side cumulative escalation guards. Mitigation: subagent runloop
is independent of parent's; compaction writes only to subagent's
stream. Parent doesn't observe subagent Anchor changes directly. If a
specific incident surfaces, narrow DD-12 to "subagent runs compaction
in `auto:false` mode only" so synthetic Continue is never injected.

**Tests**:
- `deriveObservedCondition` returns "rebind" for a subagent session
  when its pinned identity differs from its own most-recent anchor.
- Subagent overflow → run({observed: "overflow"}) → narrative path →
  subagent stream gains a summary; parent's stream unchanged.

### DD-10 — Manual /compact gains a `--rich` option

Manual `/compact` defaults to narrative-first (free in most cases). A new
`--rich` flag forces the LLM-agent kind directly, for sessions where the
user wants a full custom-prompt summary regardless of cost. Surfaced as
`POST /session/:id/compact { auto: false, rich: true }`.

## Critical Files

| File | Role | Change shape |
|---|---|---|
| `packages/opencode/src/session/memory.ts` | NEW — Memory concept implementation, render functions, persistence | Created from scratch |
| `packages/opencode/src/session/compaction.ts` | Entry point + executor implementations | Major restructure: kind-chain table, run() entry, four executors |
| `packages/opencode/src/session/shared-context.ts` | File / action metadata only | Slimmed: lose snapshot responsibility, expose metadata via Memory's API |
| `packages/opencode/src/session/prompt.ts` | Runloop state evaluation + TurnSummary capture | Three call sites collapsed to one; runloop exit gains TurnSummary append |
| `packages/opencode/src/session/processor.ts` | Mid-stream account-switch detection | `markRebindCompaction` call removed; pin-update path preserved |
| `packages/opencode/src/server/routes/session.ts` | `/compact` API endpoint | Routes through `Memory.requestCompaction()` (writes compaction-request part) — same as today, semantics unchanged |
| `packages/opencode/src/session/compaction.test.ts` | Tests | Existing 9 cases preserved; new cases for run() entry point |

## Risks / Trade-offs

### Risk: Memory turnSummary capture site is on a hot path

The runloop exit currently emits several side effects (publish events,
write workflow state). Adding a `Memory.appendTurnSummary` call here
introduces an additional Storage write per turn end. **Mitigation**: the
write is fire-and-forget; the runloop's return is not blocked on it.

### Risk: Migration overlay leaves cold sessions on legacy format indefinitely

DD-3's lazy migration means a session never re-opened after release does
not migrate. **Mitigation**: acceptable for this plan; a follow-up cleanup
phase can sweep stale legacy data after a configurable threshold (e.g.
90 days idle).

### Risk: `manual /compact --rich` is a new public surface

DD-10 adds a flag to the API. **Mitigation**: the flag is opt-in; default
behaviour does not change for existing API consumers.

### Risk: Removing `pendingRebindCompaction` may un-mask a real edge case

The flag was added 2025-late to handle a specific symptom; deleting it
relies on the assumption that every condition that previously set the flag
will be re-derivable from observable state next iteration. **Mitigation**:
the spec's R-1 scenario is the formal claim; tests cover it.

### Risk: Deprecation shim window of 1 release is aggressive

DD-6 mandates 1-release shim window. If an internal caller is missed and
slips into a release, that caller breaks immediately on the next release.
**Mitigation**: deprecation warnings fire from every shim during the
bridge release; CI greps for them.

## State-Driven Evaluation Logic (formal)

This is the core algorithm replacing the three scattered call sites in
`prompt.ts`. Pseudo-code:

```python
def runloop_iteration(session):
    # ... existing pre-LLM-call work ...

    observed = derive_observed_condition(session)
    if observed is not None:
        result = SessionCompaction.run(
            sessionID=session.id,
            observed=observed,
            step=session.step,
            intent=session.pending_compact_intent or "default",
        )
        if result == "stop":
            return "exit-loop"
        if result == "continue":
            return "next-iteration"

    # ... proceed with normal LLM call ...

def derive_observed_condition(session) -> Optional[str]:
    """Reads only observable state, sets no flags."""
    if Cooldown.is_throttled(session):
        return None

    last_anchor = Memory.most_recent_anchor(session.id)
    pinned = session.execution

    # Highest priority — manual user intent
    if has_unprocessed_compaction_request(session):
        return "manual"

    # provider/account divergence
    if last_anchor and pinned.providerId != last_anchor.providerId:
        return "provider-switched"
    if last_anchor and pinned.accountId != last_anchor.accountId:
        return "rebind"

    # token budget
    last_finished = session.last_finished_assistant
    if last_finished and is_overflow(last_finished.tokens, session.model):
        return "overflow"
    if last_finished and should_cache_aware_compact(last_finished.tokens, session.model):
        return "cache-aware"

    # idle (turn-boundary, not token-driven)
    if is_turn_boundary_idle(session):
        return "idle"

    return None
```

`derive_observed_condition` is the formal answer to "what did this
iteration see?". Every flag-based signal in the old design becomes a
state-derivable condition here.

## Kind Chain Table (data literal)

```typescript
const KIND_CHAIN: Record<Observed, KindStep[]> = {
  overflow:                [narrative, schema, replayTail, lowCostServer, llmAgent],
  "cache-aware":           [narrative, schema, replayTail, lowCostServer, llmAgent],
  idle:                    [narrative, schema, replayTail],
  rebind:                  [narrative, schema, replayTail],
  "continuation-invalidated": [narrative, schema, replayTail],
  "provider-switched":     [narrative, schema],
  manual:                  [narrative, lowCostServer, llmAgent],
  // manual + intent=rich: handled separately to skip to llmAgent
}
```

Synthetic-Continue injection map:

```typescript
const INJECT_CONTINUE: Record<Observed, boolean> = {
  overflow: true, "cache-aware": true, idle: true,
  rebind: false, "continuation-invalidated": false,
  "provider-switched": false, manual: false,
}
```

R-6 maps directly to `INJECT_CONTINUE[observed] === false` for the rebind/
continuation/provider-switch row.

## Migration Sequence (high-level)

Phase order, summarized; full task breakdown lives in `tasks.md` once the
state advances to `planned`:

1. Add `Memory` module (new file, no callers yet).
2. Add `TurnSummary` capture at runloop exit (writes to `Memory`, no readers
   downstream yet).
3. Add `SessionCompaction.run` entry point (delegates to old paths via
   shims initially).
4. Migrate the three call sites in `prompt.ts` to `run`.
5. Cut over readers (`compactWithSharedContext` callers, rebind path) to
   `Memory.renderForLLM`.
6. Add `renderForHuman` and consume in UI session-list / debug paths.
7. Replace `markRebindCompaction` / `consumeRebindCompaction` callers with
   state-driven evaluation; delete the flag implementation.
8. Replace `cooldownState` with `Memory.markCompacted` / `Cooldown.is_throttled`.
9. Remove deprecation shims (next release).

Each phase is independently reviewable and rolls back cleanly without
the next phase.
