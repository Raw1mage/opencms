# observability.md — grafcet-renderer-overhaul

## Events

The renderer's observability surface is the `trace_events` list on `LayoutModel`, plus an optional per-figure JSONL `debug.log`.

### Event taxonomy

Every event emitted to `trace_events` carries:

- `layer`: `"L1" | "L2" | "L3" | "L4" | "L5" | "L6"`
- `subject_id`: the step id, gate id, port id, anchor id, edge id, or stub id the event concerns
- `operation`: action name (e.g., `place_branch_anchor`, `assign_port_exit_dir`, `simplify_gate`, `route_transition`, `detect_stub_overlap`, `compact_gap_row`, `emit_dot`)
- `details`: structured payload — e.g. `{point: {x, y}, exit_dir: "W"}`

### Event volume

Per figure, expected event counts:

- L1 events: ~ (steps + gates + ports) ≈ 30-100 per figure
- L3 events: ~ transitions × 2 (route start + route end) ≈ 30-80 per figure
- L4 events: 1 per violation, 0 if clean
- L5 events: per gap_row compaction step
- L6 events: per emitted SVG element (boxes + gates + edges + stubs ≈ 50-200)

Total per figure: ~ 200-500 events. JSONL `debug.log` per figure ~ 50-150KB.

## Metrics

Tracked per render call (returned in `GrafcetRenderResult.metrics`, new field):

- `layer_durations_ms.{L1..L6}`: wall-clock duration spent in each layer
- `gate_count`: total gates emitted (excluding suppressed 1-in-1-out)
- `gate_suppressed_count`: gates suppressed under DD-7 / DD-8
- `branch_anchor_count`: total BranchAnchor objects placed
- `simplified_gate_ids_count`: how many gates were simplified to dots
- `violation_count_by_type`: dict of `violation.type → count`
- `route_helper_dispatch_count`: number of times `route_from_anchor` ran
- `compaction_revert_count`: how many compaction steps were reverted under R-8.2
- `cross_row_supergroup_count`: how many supergroups merged stubs across gap rows

## Logs

Two log surfaces:

1. **`trace_events` on the LayoutModel** — always populated. Existing surface; gains `layer` field.
2. **`debug.log` (JSONL)** — opt-in via `OPENCODE_GRAFCET_DEBUG=1`. Written next to the SVG. Lines:

```
{"layer": "L1", "subject_id": "branch_anchor:13", "operation": "place_branch_anchor", "details": {"point": {"x": 19.9, "y": 88.0}, "outgoing_count": 2}}
{"layer": "L1", "subject_id": "gate:diverge:13", "operation": "assign_port_exit_dir", "details": {"transition_id": "T20", "exit_dir": "W"}}
...
```

## Alerts

The renderer is a synchronous module — no live alerts. Build-time alert sources:

- CI re-render diff produces a non-zero diff against the locked baseline → CI fails.
- `plan-validate.ts` reports state-artifact mismatch → CI fails.
- `plan-sync.ts` warns of code↔spec drift → captured into history but not blocking.

## Dashboards

None — this is a non-runtime module. The "dashboard" equivalent is the per-figure `visual_review.jsonl` that Phase 7 maintains: each row is a (figure, defect_id, status, notes) tuple.
