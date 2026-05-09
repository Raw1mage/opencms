# Observability: user-msg-replay-unification

## Events

### compaction.user_msg_replay (NEW)

**Surface**: Bus.publish channel `compaction.user_msg_replay`; mirrored into `bus.session.telemetry.updated` projector.

**Schema**: per `data-schema.json` ReplayTelemetryEvent.

**Fires when**: `SessionCompaction.replayUnansweredUserMessage` is invoked, regardless of outcome.

**Fields**:
- `sessionID` — always set.
- `step` — runloop iteration step at compaction time.
- `observed` — observed condition value that drove the compaction (overflow / cache-aware / rebind / continuation-invalidated / provider-switched / stall-recovery / manual / empty-response / idle).
- `originalUserID` — set iff snapshot was non-null; the pre-replay user msg id.
- `newUserID` — set iff `outcome === "replayed"`; the post-replay user msg id.
- `anchorMessageID` — the just-written summary-true assistant msg id.
- `hadEmptyAssistantChild` — true if the snapshot included a known-empty assistant child that the helper deleted.
- `partCount` — number of parts copied from original to new user msg.
- `outcome` — one of: `replayed | skipped:already-after-anchor | skipped:no-unanswered | skipped:flag-off | error`.
- `errorMessage` — set iff `outcome === "error"`.

**Subscribers**:
- Frontend Q card session telemetry display (renders the latest replay event in the recent-events strip).
- Future: external monitoring webhook (out of scope).

### compaction.completed (EXISTING — schema unchanged)

Pre-existing event; this spec does not modify it. The cosmetic side-fix in DD-5 only affects the `recentEvents` projection's `observed` field, not this event's payload.

### bus.session.updated (EXISTING — `recentEvents` field shape extended)

Pre-existing per-session bus event. The `execution.recentEvents` ring buffer entries previously had:

```ts
{ ts: number; kind: "compaction"; compaction: { observed: string; success: boolean; ... } }
```

After this spec, additionally:

```ts
{ ts: number; kind: "compaction-replay"; replay: { outcome: string; observed?: string } }
```

Existing kinds remain unchanged. Subscribers should treat the discriminated union variant as additive.

## Metrics

### compaction.user_msg_replay.outcome

**Type**: counter, labels `{outcome, observed}`.

**Source**: derived from `compaction.user_msg_replay` event stream.

**Use**: detect regression spikes (e.g. spike of `outcome:"error"` indicates storage-layer distress; spike of `outcome:"skipped:already-after-anchor"` indicates concurrent-write race).

**Alert thresholds (recommended)**:
- `outcome:"error"` rate > 1% of compactions over 1 hour → investigate.
- `outcome:"skipped:no-unanswered"` rate > 80% of compactions → expected for clean sessions; not an alert by itself, but cross-check with manual / idle observed values to distinguish intentional from defective skipping.

### compaction.swallow.silent_exit_count (DERIVED)

**Type**: gauge, ratio.

**Source**: count of `loop:no_user_after_compaction` log lines vs total compaction events per session.

**Use**: hard regression signal — pre-fix this was the dominant failure mode for the affected paths; post-fix should approach zero except for race cases (CRH-002, TV-6).

**Alert thresholds**:
- Ratio > 5% of compactions sustained → spec was incomplete; spec should be revised.
- Ratio > 25% in any hour → emergency rollback via feature flag.

### compaction.recentEvents.observed_unknown_count (DERIVED)

**Type**: counter.

**Source**: `recentEvents.compaction.observed === "unknown"` count.

**Use**: validates the DD-5 cosmetic fix.

**Expected**: zero from prod call sites post-fix. Non-prod compaction paths (e.g. legacy `process()` retired, or test fixtures) may still emit `"unknown"` — that's acceptable.

### compaction.user_msg_replay.latency_ms (DERIVED)

**Type**: histogram, labels `{outcome}`.

**Source**: timer around helper invocation (timestamps before/after in helper itself, emitted as a sub-field of `compaction.user_msg_replay`).

**Use**: helper SLO. Target p99 < 200ms; helper does at most 5-6 SQLite writes which should be sub-ms each.

**Alert**: p99 > 500ms sustained → SQLite saturation; investigate.

## Dashboards (recommended, not required)

- **Compaction overview** — combine `compaction.completed` rate, `compaction.user_msg_replay.outcome` breakdown, `loop:no_user_after_compaction` count. Single dashboard answers "is compaction healthy?".
- **Replay outcomes pie** — share of replayed / skipped:* / error per observed value. Spot regressions per call site.
- **Session-level event timeline** — uses `recentEvents` projection (already exists in Q card); the new `compaction-replay` variant should appear adjacent to `compaction` events.

## Logs

All log lines use the `service: "session.compaction"` (helper) or `service: "session.prompt"` (caller wiring) prefix per existing convention.

**INFO level**:
- `replay: skip - <reason>` — non-error skips with full context.
- `replay: success` — replayed user msg.

**WARN level**:
- `replay: original user msg already removed` (CRH-002).
- `replay: anchorMessageID does not refer to summary-true assistant` (CRH-005).

**ERROR level**:
- `self-heal: replay-after-compact failed` (CRH-001).
- `replay: ULID monotonicity invariant violated` (CRH-003).

All ERROR-level log entries include the full `{ sessionID, step, observed, originalUserID, anchorMessageID, error }` shape for forensic reconstruction.

## Sampling / Retention

- Bus events: ephemeral (in-process EventEmitter; subscribers consume in real-time).
- `recentEvents` ring buffer: bounded by existing per-session capacity (typically last 50 events).
- debug.log: rotated per-process; retention per system config.

No new persistent log files introduced by this spec.
