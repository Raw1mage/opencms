# Spec: session_epoch-reset-orphan-hotfix

## Purpose

Make a stalled `assistant` MessageV2 row recover-deterministically when the user retypes, and make an unexpected `RebindEpoch.registry` reset visible as a runtime event. Both behaviours are additive — no existing path changes semantics.

## Requirements

### Requirement: Stalled assistant row reclaim on user-msg arrival

When `persistUserMessage` is invoked for a new user message, the helper MUST examine the immediately-preceding message in the session stream; if it is an assistant message with `time.completed === undefined` and `Date.now() - time.created >= 5000`, the helper MUST finalize that row and emit a workflow event.

#### Scenario: Orphan assistant 5s+ old gets reclaimed

- **GIVEN** session `S` has assistant message `A` with `role='assistant'`, `time.completed=undefined`, `time.created = now - 7000`
- **AND** no later message exists in the session
- **WHEN** `persistUserMessage({ info: newUserMsg, sessionID: S, ... })` runs
- **THEN** `A` is updated via `Session.updateMessage` with `time.completed = now`, `finish = "error"`, `error.name = "NamedError.Unknown"`, `error.data.message = "abandoned_orphan_round"`
- **AND** one `RuntimeEventService.append` call fires with `eventType = "session.orphan_assistant_reclaimed"`, `domain = "workflow"`, payload containing `sessionID`, `reclaimedMessageID = A.id`, `ageMs ≈ 7000`, plus `providerId`, `modelID`, `accountId` mirrored from `A`
- **AND** the new user msg is then persisted by the existing path with no further changes
- **AND** if `A.time.created` were instead `now - 2000` (under threshold), no reclaim happens

#### Scenario: No prior assistant or already completed

- **GIVEN** session `S` ends with a `user` message OR an assistant message with `time.completed` set
- **WHEN** `persistUserMessage` runs
- **THEN** no reclaim helper writes occur and no `session.orphan_assistant_reclaimed` event is emitted

### Requirement: Unexpected RebindEpoch reset emits anomaly

`RebindEpoch.bumpEpoch` MUST emit a `session.rebind_epoch_unexpected_reset` anomaly event when a `daemon_start` bump fires for a sessionID this daemon process has already bumped before, AND the in-memory registry entry currently reports epoch 0.

#### Scenario: Registry evicted then re-bumped in same process

- **GIVEN** `bumpEpoch({sessionID:"S", trigger:"daemon_start"})` previously succeeded in this process (status=bumped, epoch 0→1)
- **AND** between then and now the in-memory registry entry for `"S"` was evicted (registry.delete called by some path other than `clearSession`'s normal `session.deleted` route, OR by any future buggy path)
- **WHEN** `bumpEpoch({sessionID:"S", trigger:"daemon_start", reason:"first runLoop iteration after daemon start"})` runs
- **THEN** one `appendEventSafe` call fires with `eventType = "session.rebind_epoch_unexpected_reset"`, `domain = "anomaly"`, `anomalyFlags = ["rebind_epoch_reset"]`, payload contains `trigger`, `reason`, `sessionEntryMissing`, `everBumpedSize`
- **AND** the bump itself proceeds as before (epoch 0→1, session.rebind workflow event still fires)

#### Scenario: First-ever bump in process does not emit anomaly

- **GIVEN** `everBumped` is empty for sessionID `"S"`
- **WHEN** `bumpEpoch({sessionID:"S", trigger:"daemon_start"})` runs
- **THEN** no `session.rebind_epoch_unexpected_reset` event is emitted
- **AND** the normal `session.rebind` workflow event fires
- **AND** `everBumped` afterwards contains `"S"`

### Requirement: everBumped lifecycle

`everBumped` Set MUST be cleared in the same situations as the registry entry for cleanup hygiene, and reset by `RebindEpoch.reset()` (test seam).

#### Scenario: session.deleted clears everBumped

- **GIVEN** `"S"` is in `everBumped`
- **WHEN** the bus publishes `session.deleted` for `"S"` → `clearSession("S")` runs
- **THEN** `"S"` is no longer in `everBumped`
- **AND** `"S"` is no longer in `registry`

## Acceptance Checks

1. Unit test: orphan present, age 7s, fresh user msg → reclaim writes correct fields + emits correct event.
2. Unit test: orphan present, age 2s → no reclaim.
3. Unit test: assistant already completed → no reclaim.
4. Unit test: bumpEpoch first call → no anomaly.
5. Unit test: bumpEpoch second call after registry cleared but everBumped retained → anomaly emitted, bump still succeeds.
6. Unit test: `clearSession` removes sessionID from both registry and everBumped.
7. Manual replay: dry-run the docxmcp incident shape — first round leaves orphan, second user-msg fires reclaim, both telemetry events present.
