# Observability

How autonomous-opt-in surfaces its state to operators, UI, telemetry, and debuggers. Every state change MUST be observable — no silent flips.

## Events

All events published on the global `Bus` with the `autorun.*` prefix. UI / telemetry subscribers can filter by prefix.

| Event | Payload | Emitted by | When |
|---|---|---|---|
| `autorun.armed` | `{sessionID, slug, reason, at}` | autorun-flag-store (C5) | flag flips false→true via any valid trigger |
| `autorun.disarmed` | `{sessionID, slug, reason, at}` | autorun-flag-store (C5) | flag flips true→false (user message / blocker / abort / killswitch / binding_stale / refill_parse_error) |
| `autorun.arm_refused` | `{sessionID, slug?, reason, at}` | arm-intent-detector (C3) | trigger fired but R1/R2/R3 failed — arm not performed |
| `autorun.refill` | `{sessionID, slug, phase, taskIds, at}` | todolist-refill (C7) | phase rollover materialized new TodoWrite batch |
| `autorun.refill_exhausted` | `{sessionID, slug, at}` | todolist-refill (C7) | attempted refill found no next unchecked phase (precedes autorun.completed) |
| `autorun.completed` | `{sessionID, slug, at}` | autorun-flag-store (C5) | plan fully drained, autorun ends naturally |
| `autorun.demoted_by_edit` | `{sessionID, slug, trigger_script, from, to, at}` | r6-demote-helper (C11) | R6 demotion applied during a plan-builder write |

## Metrics

Counters and histograms to expose (initial set; extend as needed):

| Metric | Type | Labels | Purpose |
|---|---|---|---|
| `autorun_arm_count` | counter | `reason` (`verbal`, `question_yes`), `slug` | How often autorun arms, by trigger channel |
| `autorun_disarm_count` | counter | `reason` (`user_message`, `blocker`, `abort`, `killswitch`, `plan_drained`, `plan_edit_demotion`, `binding_stale`, ...) | Disarm reason distribution — for tuning trigger list and detecting noisy disarm paths |
| `autorun_arm_refused_count` | counter | `reason` (`no_binding`, `wrong_state`, `empty_todos`) | How many triggers fail preconditions — tunes user education |
| `autorun_armed_duration_seconds` | histogram | `slug` | Distribution of how long sessions stay armed — detects hangs or immediate disarms |
| `autorun_refill_count` | counter | `slug`, `phase` | Phase rollover frequency |
| `autorun_r6_demote_count` | counter | `trigger_script` (`plan-amend`, `plan-revise`, ...) | How often plan edits during implementing trigger demotion — indicates churn |
| `autorun_turn_end_latency_seconds` | histogram | `armed` (bool) | Chat-turn latency vs armed-turn latency — verifies the 30s-chat-latency removal goal |

## Logs

All log lines emitted by autonomous-opt-in code paths carry the `[autorun]` prefix for quick grep. Structured logging preferred where the codebase already uses it.

Examples (informational; not exhaustive):

```
[autorun] armed session=S1 slug=foo reason=verbal:start building at=2026-04-19T10:23:45Z
[autorun] disarmed session=S1 slug=foo reason=user_message at=2026-04-19T10:27:12Z
[autorun] arm_refused session=S1 reason=no_binding phrase="start building" at=2026-04-19T10:22:01Z
[autorun] refill session=S1 slug=foo phase=2 taskCount=4 at=2026-04-19T10:25:33Z
[autorun] demoted_by_edit session=S1 slug=foo trigger=plan-amend from=implementing to=planned at=2026-04-19T10:30:02Z
```

## Alerts (deferred to Phase 2)

Not in initial scope; listed for future work:

- `autorun_arm_refused_rate > 50% over 1h` → user education / phrase list tuning needed
- `autorun_armed_duration p99 > 4h` → potential hung armed session
- `autorun_r6_demote_count > 10/day per spec` → plan is churning; user may need `refactor` mode instead of amend

## Debug Hooks

- `OPENCODE_AUTORUN_DEBUG=1` env flag → verbose arm/disarm logging with full decision trace
- `bun run scripts/autorun-state.ts <sessionID>` (optional future tool) → print current binding, armed flag, last 10 Bus events for a session
