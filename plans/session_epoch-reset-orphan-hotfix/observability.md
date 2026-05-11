# Observability: session_epoch-reset-orphan-hotfix

## Events

The hotfix introduces three runtime event types via the existing `RuntimeEventService.append` API. No new metric backend is added — observability rides on the existing journal and projection.

## Metrics

No new metric counters / histograms added. Aggregation is post-hoc via `jq` over the per-session JSON journal (see "How to observe" below) or the existing web-UI telemetry sidebar projection.

If alerting is added later, it goes in a follow-up spec — see "Alert hooks (future)" at the bottom.

## New runtime events

| Event Type | Domain | Level | Anomaly Flags | When |
|---|---|---|---|---|
| `session.orphan_assistant_reclaimed` | workflow | info | (none) | persistUserMessage detected an orphan ≥5s old and finalized it |
| `session.orphan_assistant_reclaim_failed` | workflow | warn | (none) | Same predicate fired but `Session.updateMessage` threw |
| `session.rebind_epoch_unexpected_reset` | anomaly | warn | `rebind_epoch_reset` | RebindEpoch.bumpEpoch saw `daemon_start` + `previousEpoch=0` + everBumped.has(sid) |

Payload fields are normative — see `data-schema.json#events`.

## Existing events that remain unchanged

- `session.rebind` (workflow) — always fires on successful bump as before.
- `session.rebind_storm` (anomaly) — rate-limit anomaly path unchanged.

## How to observe

### Live tail (per session)

```
tail -f ~/.local/share/opencode/storage/session_runtime_event/<sessionID>.json | \
  jq 'select(.eventType | test("orphan_assistant|rebind_epoch_unexpected"))'
```

### Aggregate (last 24h)

```
find ~/.local/share/opencode/storage/session_runtime_event -name '*.json' -mtime -1 \
  -exec jq -c '.[] | select(.eventType=="session.rebind_epoch_unexpected_reset")' {} \;
```

### Telemetry sidebar (web UI)

Both events render through the existing runtime-event projection (`RuntimeEventService.project`). No new sidebar code needed; anomaly events will appear under the "Anomaly" filter automatically.

## Expected baseline volumes

- `session.orphan_assistant_reclaimed` — expect near-zero. Any sustained volume signals the underlying stream-silence bug is recurring. Track weekly.
- `session.rebind_epoch_unexpected_reset` — unknown baseline (this is new data). Initial week of telemetry is the RCA evidence collection window.

## Alert hooks (future)

Not added by this hotfix. After one week of data, if either event rate exceeds a threshold, separate spec should propose alerting.
