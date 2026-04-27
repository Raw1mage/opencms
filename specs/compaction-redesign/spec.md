# Spec: compaction-redesign

## Purpose

The compaction subsystem reduces a session's effective message-stream size before
the next LLM call so that:

1. The next call fits within the active model's context window.
2. The next call's KV-cache prefix stays bounded.
3. The next call survives provider switch, account rotation, daemon restart,
   and continuation-invalidation without losing causal context.

This spec covers the **behavior** of the redesigned subsystem (one entry point,
state-driven evaluation, cost-monotonic kind selection, narrative-first memory).
Implementation details live in `design.md`; concrete data shapes live in
`data-schema.json`.

## Scope

In scope: the public behaviour of `Memory`, `Anchor`, `Cooldown`, the single
entry point `SessionCompaction.run`, the runloop's per-iteration state
evaluation, and the four kind-of-compaction execution paths (free narrative,
free schema, low-cost server-side, LLM agent).

Out of scope: provider-side compaction implementation (codex `/responses/compact`),
runloop architecture beyond the one capture site, UI changes beyond consuming
`renderForHuman()`.

## Requirements

### Requirement: R-1 Single entry point with state-driven evaluation

The system **shall** route every compaction execution through one entry point
`SessionCompaction.run({sessionID, observed, step})`. The `observed` field
records what condition the runloop saw (overflow / cache-aware / rebind /
continuation-invalidated / provider-switched / manual); it is a log/event
attribution label, not a separate code path.

#### Scenario: runloop evaluates from current state each iteration

- **GIVEN** a runloop iteration begins
- **WHEN** the iteration reads `lastFinished.tokens`, the session's pinned
  identity, the most recent `Anchor`, and the tail of the message stream
- **THEN** the iteration calls `SessionCompaction.run` if and only if at
  least one of these conditions holds:
  - `tokens.total` exceeds the model's per-request budget (overflow)
  - `tokens.total` exceeds the cache-aware threshold (cache-aware)
  - the session's pinned `accountId` or `providerId` differs from the most
    recent `Anchor`'s identity (rebind)
  - the most recent user-message-stream tail contains an unprocessed
    `compaction-request` part (manual)
- **AND** no `Cooldown` block is in effect

#### Scenario: previous-iteration flags are not consulted

- **GIVEN** a previous iteration observed an account switch and updated
  the session's pinned identity
- **WHEN** the next iteration begins
- **THEN** the next iteration evaluates the rebind condition based on the
  current pinned identity vs current most-recent `Anchor`
- **AND** the system **shall not** consult any in-memory flag set by the
  previous iteration to make this decision

### Requirement: R-2 Cost-monotonic kind selection

`SessionCompaction.run` **shall** pick the compaction kind by walking a
priority chain in order, picking the first kind that succeeds. The chain is
monotonic in cost.

#### Scenario: free narrative path succeeds

- **GIVEN** `Memory.turnSummaries` is non-empty
- **AND** `Memory.renderForLLM(sid)` produces a string fitting within 30%
  of the active model's context window
- **WHEN** `run` is invoked with any `observed` value
- **THEN** the system writes a new `Anchor` whose summary text equals
  `renderForLLM(sid)`
- **AND** no API call is made
- **AND** `Cooldown.recordCompaction(sid, step)` is called

#### Scenario: free narrative insufficient, fall through to next kind

- **GIVEN** `Memory.turnSummaries` is empty (e.g. first turn)
- **AND** `observed` permits paid kinds (overflow / cache-aware / manual)
- **WHEN** `run` is invoked
- **THEN** the system attempts kinds in order: free schema → free replay tail
  → low-cost server-side (if provider supports it) → LLM agent
- **AND** every fallback transition emits a `log.info` line naming the
  attempted kind and the reason for falling through (per AGENTS.md rule 1)

#### Scenario: rebind / provider-switch refuses paid kinds

- **GIVEN** `observed = "rebind"` or `observed = "continuation-invalidated"`
  or `observed = "provider-switched"`
- **WHEN** `run` walks the chain
- **THEN** the system shall consider only free kinds (narrative / schema /
  replay tail)
- **AND** if no free kind succeeds, `run` returns `"stop"` and emits
  `log.warn` rather than escalating to paid kinds

### Requirement: R-3 Memory backed by TurnSummary, captured at runloop exit

`Memory` **shall** derive its primary narrative content from `TurnSummary`
entries captured at runloop exit (the `exiting loop` site, currently
`prompt.ts:1230`).

#### Scenario: runloop exit captures TurnSummary

- **GIVEN** the runloop reaches its exit point with `lastAssistant.finish`
  set to a non-`tool-calls` value
- **WHEN** the exit handler runs
- **THEN** the system appends a new `TurnSummary` to `Memory.turnSummaries`
  with `text = lastAssistant`'s final text part, `endedAt = now`,
  `userMessageId = lastUser.id`, `modelID = lastAssistant.modelID`
- **AND** the append is durable before the runloop returns

#### Scenario: mid-run crash recovery uses raw tail, not partial summary

- **GIVEN** an autonomous runloop is interrupted before reaching exit
- **WHEN** rebind / daemon restart triggers context recovery
- **THEN** the system shall use `Memory`'s last-N-rounds raw tail as the
  recovery context
- **AND** the system shall not synthesize a partial `TurnSummary` from
  the interrupted run

### Requirement: R-4 Manual `/compact` uses the same entry, narrative-preferred policy

Manual `/compact` invocation (via `routes/session.ts:1708`) **shall** route
through `SessionCompaction.run` with `observed = "manual"`. Its kind chain
prioritizes narrative over schema (the inverse of overflow's chain on
schema's side, since schema doesn't preserve reasoning that the user
requested compaction precisely to keep).

#### Scenario: manual /compact prefers free narrative

- **GIVEN** the user invokes `/compact` with default flags
- **WHEN** `run` is invoked with `observed = "manual"`
- **THEN** the chain order is: free narrative → low-cost server-side →
  LLM agent
- **AND** free schema is **not** considered (would defeat user intent)

#### Scenario: manual /compact --rich forces LLM agent

- **GIVEN** the user invokes `/compact --rich`
- **WHEN** `run` is invoked with `observed = "manual"` and `intent = "rich"`
- **THEN** the chain skips kinds 1-3 and goes straight to LLM agent

### Requirement: R-5 Provider-switch uses narrative only

When a provider switch occurs mid-session, the next iteration **shall**
write a new `Anchor` from `renderForLLM` (narrative form, plain text,
provider-agnostic) before any LLM call against the new provider.

#### Scenario: provider switch refuses non-narrative kinds

- **GIVEN** the session's pinned `providerId` differs from the most recent
  `Anchor`'s `providerId`
- **WHEN** the runloop iteration evaluates
- **THEN** `run` is called with `observed = "provider-switched"`
- **AND** only kinds 1 (free narrative) and 2 (free schema) are tried
- **AND** kind 3 (replay tail) is rejected because raw tail contains
  provider-specific tool-call format
- **AND** kind 4 (low-cost server-side) is rejected because codex/openai
  format is unreadable by other providers

### Requirement: R-6 Rebind never injects synthetic Continue

`SessionCompaction.run` **shall not** inject a synthetic `"Continue if you
have next steps..."` user message when `observed ∈ {"rebind",
"continuation-invalidated", "provider-switched"}`. Synthetic Continue is
permitted only for `observed ∈ {"overflow", "cache-aware", "idle"}`.

#### Scenario: rebind compaction returns without Continue injection

- **GIVEN** `observed = "rebind"`
- **WHEN** `run` writes a new `Anchor` and returns `"continue"`
- **THEN** no synthetic user message is appended to the session stream

This makes the 2026-04-27 runloop infinite-loop bug structurally
unrepresentable: the path that previously injected Continue on rebind no
longer exists in the new entry point.

### Requirement: R-7 Memory persistence is single-write, fallback-read

`Memory` **shall** persist to a single new path (`session_memory/<sid>` in
Storage). Reads **shall** check the new path first, falling back to legacy
locations (`shared_context/<sid>`, `Global.Path.state/rebind-checkpoint-<sid>.json`)
only when the new path is empty.

#### Scenario: legacy session is migrated lazily on first touch

- **GIVEN** a session with legacy SharedContext / checkpoint data only
- **WHEN** `Memory.read(sid)` is first called for that session
- **THEN** the system reads from legacy paths
- **AND** projects the legacy shape to the new SessionMemory shape
- **AND** writes the projected shape to the new path
- **AND** subsequent reads use the new path directly

### Requirement: R-8 Two-form render

`Memory` **shall** expose two independent render functions: `renderForLLM(sid)`
returning compact provider-agnostic text for the next LLM call, and
`renderForHuman(sid)` returning timeline-formatted text for UI / debug.

#### Scenario: render functions are independent

- **GIVEN** a session with non-empty `Memory`
- **WHEN** `renderForLLM(sid)` and `renderForHuman(sid)` are both called
- **THEN** each returns a string optimized for its consumer
- **AND** changes to one render's output format do not affect the other
- **AND** both functions read from the same underlying `Memory` data

### Requirement: R-9 Deprecation shim window: 1 release (actual surface revised at phase 9)

**Initial framing** (proposal): all of `SharedContext.snapshot`,
`saveRebindCheckpoint`, `loadRebindCheckpoint`,
`SessionCompaction.process`, `compactWithSharedContext`,
`markRebindCompaction`, `consumeRebindCompaction`, `recordCompaction`
**shall** be deprecation shims, removed next release.

**Phase 9 realignment** (2026-04-27): the original list conflated
internal-helper APIs (still actively used by the new path) with
truly-dead public surface. Final scope:

| API | Status |
|---|---|
| `markRebindCompaction` / `consumeRebindCompaction` | **Deleted** in phase 7 (no shim, removed entirely — flag plumbing replaced by `session.execution.continuationInvalidatedAt` per DD-11) |
| `SessionCompaction.process` | **Deprecated shim** — delegates to `run({observed: input.auto ? "overflow" : "manual"})` + `log.warn`. Phase 12 deletes. |
| `SessionCompaction.recordCompaction` | **Deprecated shim** — delegates to `Memory.markCompacted` + `log.warn`. Phase 12 deletes. |
| `SessionCompaction.compactWithSharedContext` | **Kept (internal helper)** — production anchor-write path used by `_writeAnchor` + pre-loop identity-switch compaction. Not deprecated. |
| `SharedContext.snapshot` | **Kept (executor source)** — `trySchema` reads it for the schema kind. Not deprecated. |
| `saveRebindCheckpoint` / `loadRebindCheckpoint` | **Kept (rebind recovery)** — disk file still drives restart/rebind context restoration. `lastMessageId` made optional in phase 8 (DD-8). Not deprecated. |
| `getCooldownState` | **Kept (cooldown read path)** — used by `isOverflow` / `shouldCacheAwareCompact`. Not deprecated. |

#### Scenario: deprecated API call emits warning

- **GIVEN** a caller invokes `SessionCompaction.process` or
  `SessionCompaction.recordCompaction`
- **WHEN** the call is made
- **THEN** the shim delegates to the new equivalent and emits a
  `log.warn` containing the migration-target identifier
- **AND** the caller's behaviour is preserved (`process` returns
  `"continue" | "stop"`, `recordCompaction` writes to
  `Memory.markCompacted`)

#### Scenario: kept-helper APIs do NOT emit deprecation warnings

- **GIVEN** the new path's executors call `SharedContext.snapshot`,
  `compactWithSharedContext`, `loadRebindCheckpoint`, etc., as part of
  normal operation
- **WHEN** these internal helpers are invoked
- **THEN** no `log.warn` fires
- **AND** the call site is documented as "internal helper, not
  deprecated"

### Requirement: R-10 Continuation-invalidated is state-driven, not flag-based (added 2026-04-27 v2)

When the codex provider rejects `previous_response_id`, the recovery
signal **shall** live in observable session state, not in a module-level
in-memory flag. Specifically: the codex Bus listener writes
`session.execution.continuationInvalidatedAt = Date.now()`. The runloop's
`deriveObservedCondition` returns `"continuation-invalidated"` when this
timestamp is newer than the most recent `Anchor`'s `time.created`.

#### Scenario: continuation-invalidated fires after codex Bus event

- **GIVEN** the codex provider has just fired `ContinuationInvalidatedEvent`
  for `sessionID`
- **AND** the Bus listener has written `session.execution.continuationInvalidatedAt = T`
- **AND** the most recent `Anchor` has `time.created < T`
- **WHEN** the next runloop iteration calls `deriveObservedCondition`
- **THEN** the function returns `"continuation-invalidated"`
- **AND** `run({observed: "continuation-invalidated"})` writes a fresh
  Anchor with `time.created > T`

#### Scenario: signal is naturally stale once anchor advances past it

- **GIVEN** `run({observed: "continuation-invalidated"})` has just succeeded
- **AND** the resulting Anchor's `time.created > continuationInvalidatedAt`
- **WHEN** the iteration AFTER that one calls `deriveObservedCondition`
- **THEN** the function returns `null` for the continuation-invalidated
  branch (the signal is dormant; no flag-clear step is needed)

### Requirement: R-11 Subagent sessions use the state-driven path identically (added 2026-04-27 v2)

`deriveObservedCondition` **shall not** unconditionally skip subagent
sessions (`session.parentID` set). Subagents trigger compaction via the
same state-driven path as parents for `rebind`,
`continuation-invalidated`, `provider-switched`, `overflow`,
`cache-aware`. Compaction writes to the **subagent's own message
stream**, not the parent's. The only `observed` value subagents do
**not** trigger is `"manual"` (subagents have no UI surface).

#### Scenario: subagent rebind writes anchor on subagent's own stream

- **GIVEN** a subagent session whose `pinnedAccountId` differs from its
  own most-recent `Anchor`'s `accountId`
- **WHEN** the subagent's runloop iteration calls `deriveObservedCondition`
- **THEN** the function returns `"rebind"` (parentID does not auto-skip)
- **AND** `run({sessionID: subagent.id, observed: "rebind"})` writes the
  anchor on the subagent's stream
- **AND** the parent session's stream is unchanged

#### Scenario: subagent does not trigger manual

- **GIVEN** a subagent session with an unprocessed `compaction-request`
  part in its tail (theoretically — subagents shouldn't normally have
  these, but defence-in-depth)
- **WHEN** `deriveObservedCondition` is called
- **THEN** the function returns the next applicable observed value
  (rebind / overflow / etc.) or `null` — never `"manual"`

## Acceptance Checks

- All 9 existing test cases in `compaction.test.ts` pass.
- New test: `run({observed: "rebind"})` does not produce a synthetic
  Continue user message.
- New test: `run({observed: "manual"})` with non-empty `Memory` returns
  `"continue"` without making any API call.
- New test: `run({observed: "provider-switched"})` rejects kind 3 (raw
  tail) and kind 4 (low-cost server-side).
- New test: `Memory.renderForLLM` and `Memory.renderForHuman` produce
  syntactically distinct strings for the same session.
- Manual smoke: invoking `/compact` in a populated session writes a new
  `Anchor` and consumes no API quota (verifiable via codex usage logs).
- Manual smoke: triggering an account rotation mid-session produces
  exactly one rebind `Anchor` write per rotation, never two.
- Code-grep: no remaining caller of `markRebindCompaction` or
  `consumeRebindCompaction` outside the deprecation shim file.
