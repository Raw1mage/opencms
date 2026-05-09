# Spec: user-msg-replay-unification

## Purpose

Make the post-condition "if an unanswered user message existed pre-compaction, an unanswered user message exists post-compaction with id > anchor.id" hold for **every** compaction commit path, not just the one path covered by the 2026-05-05 hotfix. Implement once inside `SessionCompaction`, fire automatically from every commit site, replace the static `INJECT_CONTINUE` table with stream-driven runtime decision.

## Requirements

### Requirement: Post-anchor user-message preservation

When `SessionCompaction.run` (or the legacy `compactWithSharedContext` direct caller) writes a compaction anchor, an unanswered user message that existed pre-write must remain visible to the next runloop iteration with `id > anchor.id`. This applies regardless of `observed` value or kind chain outcome.

#### Scenario: Rebind pre-emptive compaction with bloated session

- **GIVEN** a session at tokenRatio 0.787 with an unanswered user message at id `msg_X` (id < newly-written anchor's id)
- **AND** rebind pre-emptive compaction fires at `prompt.ts:2114` with `observed: "rebind"`
- **AND** kind chain returns `narrative` after `low-cost-server` 429s
- **WHEN** `SessionCompaction.run` returns "continue"
- **THEN** the messages stream contains a new user message `msg_Y` with `id > anchor.id`
- **AND** the new message has identical info-shape and parts to `msg_X`
- **AND** `msg_X` no longer exists in the stream
- **AND** `loop:no_user_after_compaction` log is NOT emitted on next iter

#### Scenario: Empty-response self-heal compaction (5/5 hotfix path preserved)

- **GIVEN** the runloop hit `emptyRoundCount === 1`, `overflowSuspected === true`, with unanswered user msg `msg_X`
- **WHEN** the now-removed inline replay logic in `prompt.ts:1484-1554` would have run
- **THEN** the helper inside `SessionCompaction.run` produces equivalent state (replay user msg, delete original + empty assistant child)
- **AND** the inline 70-line replay block is deleted from `prompt.ts`
- **AND** the test fixtures from the 5/5 hotfix all pass against the helper

#### Scenario: Manual /compact without unanswered user msg

- **GIVEN** the user types `/compact` after a clean assistant turn (no unanswered question)
- **WHEN** `SessionCompaction.run({ observed: "manual" })` writes its anchor
- **THEN** the helper detects no unanswered user msg
- **AND** the helper does NOT replay anything
- **AND** the helper does NOT inject a synthetic Continue (DD-4 runtime check; the user's `/compact` request msg already exists post-anchor)

### Requirement: Helper-internal idempotency

Calling the replay helper twice in a row (e.g. a retry after a transient SQLite error) must not duplicate the user message or leave the stream in an inconsistent state.

#### Scenario: Retry after partial failure

- **GIVEN** the helper has already replayed `msg_X` to `msg_Y` and deleted `msg_X`
- **WHEN** a retry path invokes the helper again with the same snapshot
- **THEN** the helper detects `snapshot.id` no longer exists in the stream
- **AND** returns `{ replayed: false, reason: "snapshot-already-consumed" }`
- **AND** does not write a duplicate `msg_Y` or `msg_Y'`

### Requirement: Telemetry for previously-silent failures

Every helper invocation emits a structured telemetry event surfacing the outcome.

#### Scenario: Successful replay

- **GIVEN** any successful replay
- **WHEN** the helper returns
- **THEN** an event `compaction.user_msg_replay` is published with `outcome: "replayed"` and full `{originalUserID, newUserID, anchorMessageID, observed, partCount}`
- **AND** the session's `recentEvents` ring buffer gets one entry of `{kind: "compaction-replay", ...}` (alongside the existing compaction event)
- **AND** the debug.log line includes all the same fields per AGENTS.md rule 1

#### Scenario: Helper exception

- **GIVEN** a SQLite write failure during the helper's `Session.updateMessage` call
- **WHEN** the catch block catches the error
- **THEN** `log.error` records the full stack with `{sessionID, step, observed, originalUserID, anchorMessageID, error}`
- **AND** telemetry is published with `outcome: "error"`
- **AND** the helper returns `{ replayed: false, reason: "exception" }`
- **AND** the runloop's caller does NOT throw (degrades gracefully to today's silent-exit behaviour, which is the floor not a regression)

### Requirement: Cosmetic side-fix for recentEvents observed field

The two bare `publishCompactedAndResetChain(sessionID)` call sites must thread `{ observed, kind }` so `recentEvents.compaction.observed` records the real value instead of `"unknown"`.

#### Scenario: Compaction via compactWithSharedContext legacy path

- **GIVEN** the provider-switch pre-loop at `prompt.ts:1099-1146` calls `compactWithSharedContext` directly
- **WHEN** the inner `publishCompactedAndResetChain` fires
- **THEN** the published Compacted event AND `recentEvents` ring buffer record `observed: "provider-switched"` (not `"unknown"`)

#### Scenario: Compaction via runLlmCompact

- **GIVEN** any kind-5 LLM-agent compaction completes
- **WHEN** the `finally` block in `runLlmCompact` calls `publishCompactedAndResetChain`
- **THEN** the published event records the calling `observed` value (not `"unknown"`)

### Requirement: Feature flag rollback path

Setting `Tweaks.compactionSync().enableUserMsgReplay = false` must restore today's behaviour exactly (helper skipped at all call sites, `INJECT_CONTINUE` falls back to a static table mirroring the old hardcoded values).

#### Scenario: Flag disabled mid-session

- **GIVEN** a running session with `enableUserMsgReplay = false`
- **WHEN** any compaction commit fires
- **THEN** the helper is not invoked (early return)
- **AND** the post-anchor stream behaviour matches pre-fix (user msg may be hidden behind anchor)
- **AND** `INJECT_CONTINUE` table-driven decision is used

## Acceptance Checks

1. **All 4 call sites covered** — integration tests (one per site: empty-response / overflow / rebind / provider-switch) prove the post-condition holds.
2. **5/5 hotfix tests still pass** — existing test coverage in `prompt.ts` empty-response scenarios continues to pass after the inline replay deletion.
3. **Idempotency** — calling the helper twice with the same snapshot does not duplicate.
4. **Subagent compatibility** — `session.parentID !== undefined` does not break the helper.
5. **Telemetry fields complete** — every emit includes `{sessionID, step, observed, originalUserID, newUserID, anchorMessageID, hadEmptyAssistantChild, partCount, outcome, errorMessage?}`.
6. **`recentEvents.observed` is never `"unknown"` for compactions originating from prod call sites** — verified via debug.log grep on a synthetic session that exercises all observed values.
7. **Feature flag rollback** — `enableUserMsgReplay = false` restores exact pre-fix behaviour; flag toggle is hot (no daemon restart needed).
8. **No regression in `loop:no_user_after_compaction` callsite** — the log line stays as a diagnostic for the remaining race-case (snapshot already after anchor at start of compaction); production occurrences should drop to ~zero.
