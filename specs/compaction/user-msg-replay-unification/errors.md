# Errors: user-msg-replay-unification

Per AGENTS.md rule 1 + memory `feedback_no_silent_fallback.md`, every helper branch logs explicitly. The helper itself never throws (DD-2 #9). All errors degrade gracefully.

## Error Catalogue

### CRH-001 — replay storage write failed

**Trigger**: `Session.updateMessage(newUser)` or `Session.updatePart(...)` throws (e.g. SQLITE_BUSY, disk full, schema mismatch).

**Severity**: Low — degrades to pre-fix behaviour for this iter only.

**Surface**:
- `log.error("self-heal: replay-after-compact failed; user message may be hidden behind anchor", { sessionID, step, observed, originalUserID, anchorMessageID, error })`
- Bus event `compaction.user_msg_replay { outcome: "error", errorMessage: <stack-summary> }`
- Helper return: `{ replayed: false, reason: "exception" }`

**Recovery**: caller (defaultWriteAnchor / tryLlmAgent / provider-switch path) does not throw. Runloop continues. Symptom: this iter may show `loop:no_user_after_compaction` and exit cleanly. User retypes; next compaction has a fresh chance.

**Ops detection**: grep debug.log for `replay-after-compact failed`. Frequency baseline expected to be ~zero; sustained occurrence indicates storage-layer issue, not a replay defect.

### CRH-002 — original user msg already deleted before helper ran

**Trigger**: between snapshot and helper invocation, another writer removed `snapshot.info.id`. Helper's `Session.removeMessage(snapshot.info.id)` would no-op or throw.

**Severity**: Low — race; the new user msg is still successfully written. Original removal is best-effort.

**Surface**:
- `log.warn("replay: original user msg already removed", { sessionID, originalUserID })`
- Helper still returns `{ replayed: true, newUserID }` because the postcondition (user msg post-anchor) is met.

**Recovery**: no special handling. The helper's state mutation is forward-progress only.

### CRH-003 — replay attempted but storage layer rejects new ULID monotonicity

**Trigger**: `Identifier.ascending("message")` returns an id that is NOT > anchor.id (clock skew + monotonicity layer failure). Helper's invariant check fails.

**Severity**: Medium — would re-enter the original bug if not caught.

**Surface**:
- `log.error("replay: ULID monotonicity invariant violated", { sessionID, newUserID, anchorMessageID, comparison })`
- Bus event `compaction.user_msg_replay { outcome: "error", errorMessage: "ULID monotonicity violated" }`
- Helper return: `{ replayed: false, reason: "exception" }`

**Recovery**: same as CRH-001. The postcondition is not met for this iter; degrades to pre-fix.

**Ops detection**: should be impossible by design (ULID monotone via `Identifier.ascending`). Sustained occurrence indicates a clock or library defect.

### CRH-004 — feature flag toggled mid-session into unexpected state

**Trigger**: operator sets `enableUserMsgReplay = false` while a compaction is in flight. The pre-snapshot and post-anchor calls observe different flag values.

**Severity**: Low — graceful; one of: (a) snapshot taken but replay skipped → fall back to INJECT_CONTINUE table (matches pre-fix); (b) snapshot skipped but replay fires anyway → no-op because no snapshot.

**Surface**:
- `log.info("replay: feature flag flipped mid-call, falling back to skip", { sessionID, flagAtSnapshot, flagAtReplay })`
- Helper return: `{ replayed: false, reason: "feature-flag-disabled" }`

**Recovery**: none required. Flag-toggle is intended ops-time behaviour.

### CRH-005 — helper called outside compaction commit context

**Trigger**: a future caller invokes `replayUnansweredUserMessage` without a preceding anchor write. `anchorMessageID` doesn't correspond to a real summary-true assistant message.

**Severity**: Low — defensive check.

**Surface**:
- `log.warn("replay: anchorMessageID does not refer to a summary-true assistant message; skipping", { sessionID, anchorMessageID })`
- Helper return: `{ replayed: false, reason: "exception" }` (subcategory: invalid-anchor-id)

**Recovery**: skip. Caller ate the input.

### CRH-006 — telemetry emit failed (Bus.publish throws)

**Trigger**: Bus is dead / GlobalBus EventEmitter has too many listeners / serializer throws.

**Severity**: Low — telemetry is non-load-bearing per memory; helper still returns success result.

**Surface**:
- `console.error('[CRH-006] telemetry emit failed', err)` (cannot use log because log itself may share the same Bus path).
- Helper return value is unaffected.

**Recovery**: skip. Helper's success doesn't depend on telemetry.

## Non-Errors (intentional skip outcomes)

These return `replayed: false` with a `reason` that is NOT an error:

| reason | Meaning |
|--------|---------|
| `already-after-anchor` | snapshot.id > anchor.id (race or extra user msg added in between) |
| `no-unanswered` | snapshotUnansweredUserMessage returned undefined |
| `snapshot-already-consumed` | helper called twice with same snapshot, second call no-op |
| `feature-flag-disabled` | enableUserMsgReplay === false |

These all emit `telemetry { outcome: "skipped:<reason>" }` and `log.info` — not error level.

## Watchpoints (sustained occurrence triggers human attention)

- CRH-001 sustained > 1/hour on prod sessions → storage layer in distress; escalate.
- CRH-003 ANY occurrence → ULID library defect; halt rollout; investigate `Identifier.ascending`.
- `loop:no_user_after_compaction` log AFTER this fix lands → ops sanity check; expected near-zero. Sustained > 1% of compactions → spec was incomplete; revise.
