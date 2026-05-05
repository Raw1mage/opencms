# design.md — grafcet-renderer-overhaul

## Context

`grafcet_renderer.py` is a 4000+ line single-file Python module that produces SVG diagrams from JSON grafcet step descriptions.

**Layer model — authoritative as of 2026-05-05 (user directive):**

- **L1 — Box & Gate**: place step boxes, action boxes, gates (incl. simplification rule, branch anchors, ports w/ exit_dir).
- **L2 — Routing**: build all edge routes from finalized port positions (no stub work).
- **L3 — Routing Validation**: detect routing-only violations (cross-box, cross-bar, channel collision); feed back to L2 if needed.
- **L4 — Stub**: place ConditionStubs **after** routing is validated; stub center derives from finalized route geometry. Sole layer responsible for stub center + alignment.
- **L5 — Balance**: grouping → remapping → compaction → refit. Operates on Y; never re-places stubs.
- **L6 — Text**: text/label rendering, wrap, alignment cluster locking.

This re-numbering supersedes the historical "L1 placement / L2 gate arrange / L3 routing / L4 violation / L5 compaction / L6 emit" model. In the historical model, stub placement was scattered across L1 (slot reservation), L3 (center from route midpoint), and L5 (re-snap fallback) — that is exactly the source of the recurring stub regressions ("修復點放在錯的 Layer"). Under the new model stub is one layer with one responsibility.

The module evolved through many bug-driven patches; the current state shows architectural strain: route helpers proliferate (one per topology corner case), L6 has logic that should live earlier, and L1 makes port placement decisions whose consequences routing must later undo.

User has reported 23 distinct defects (D-01 to D-23) across nine grafcet figures. Diagnostic walkthrough this session traced the recurring "feedback line emerges from gate side" symptom to a structural cause: **L1 places port positions that do not encode route intent, and L3 plays guessing games per route to compensate**. Every other reported defect class can be traced to a similar layer-of-concern leak.

## Goals / Non-Goals

### Goals

- G1. Make the L1→L3 contract direction-aware so each route is a port-walk.
- G2. Move consecutive-gate simplification to L1 so routing honours the dot anchor from the start.
- G3. Suppress 1-in-1-out and M-in-N-out gate symbols at construction time.
- G4. Add a right-side bus for forward bypass so forward and feedback don't compete for the left lane.
- G5. Add stub-on-segment violation detection in L4 and prevent L5 from masking pre-existing violations.
- G6. Step box sizing: figure-uniform width based on widest 3-line wrap; 3-line height regardless of actual wrap.
- G7. Render log per layer with greppable layer tags + per-figure `debug.log` opt-in.
- G8. Re-render every figure under `/specs/*/grafcet.json`; verify each visually via main-agent multimodal read.

### Non-Goals

- NG1. Replacing the file with multi-module structure. Keep `grafcet_renderer.py` as a single file (the layer functions remain top-level).
- NG2. Switching to an external layout solver (e.g., graphviz). Algorithms stay pure-Python.
- NG3. Pixel-perfect parity with current SVGs. Routes will move; that's the point.
- NG4. Adding new figure categories. Render only what's already in `/specs/*/grafcet.json`.
- NG5. Changing the input JSON schema.

## Decisions

- **DD-1** — `Port` schema gains `exit_dir: Literal["N","S","E","W"]`. Default values fed by L1 based on transition topology. (2026-05-05)

- **DD-2** — `BranchAnchor` is generalized: any step with `|outgoing| ≥ 2` gets one. Anchor point = `(step.col_x, step.bottom + ROUTE_CHANNEL_WIDTH)`. (2026-05-05)

- **DD-3** — All output ports of a single diverge gate collapse to the same anchor point. They differ only in `exit_dir` and `target_id`. The bar (when rendered) draws from `anchor.x - half_width` to `anchor.x + half_width` at `anchor.y`. (2026-05-05)

- **DD-4** — `simplified_gate_ids` computation moves from `emit_layout_svg` (L6) to `arrange_transition_gates` (L1). Routing reads it. (2026-05-05)

- **DD-5** — Route helpers consolidate into a single `route_from_anchor(start_port, end_port, layout_model, lane_x_provider)` function. The function dispatches on `start_port.exit_dir` × `end_port.exit_dir` × topology (feedback / spine forward / bypass). The existing `_feedback_*`, `_forward_*`, `_branch_rail_*` helpers are deleted; their logic merges into this dispatcher. (2026-05-05)

- **DD-6** — Right-side bus column lives at `max(step_box.right) + LEFT_BUS_LANE_GAP` (symmetric with left bus to the left of `min(step_box.left)`). Same channel slot mechanism as left bus. (2026-05-05)

- **DD-7** — 1-in-1-out gate suppression: in `arrange_transition_gates`, after the gate group is built, if `len(source_ids) == 1 AND len(target_ids) == 1`, the gate is NOT added to `gates`; instead the transition's condition is added to `condition_stubs` directly. The transition's source-gate edge becomes a step-to-step direct edge with the stub anchored to it. (2026-05-05)

- **DD-8** — M-in-N-out gate handling: in `arrange_transition_gates`, before constructing the gate, if both arities exceed 1, split into a converge G_c (sources → 1 dummy waypoint) plus a diverge G_d (1 dummy waypoint → targets). Both share the same anchor y; G_c renders as bar, G_d renders as dot per R-3 simplification rule. (2026-05-05)

- **DD-9** — Step box width = `max over all step boxes in figure of width_for_3_line_wrap(text) + 0.2u`. Step box height = `3 * LINE_HEIGHT + vertical_padding`. Text vertically centered within the box. (2026-05-05)

- **DD-10** — Stub-on-segment check added to `detect_layout_violations`: iterate over (stub, edge_segment) pairs; emit violation when stub.y == segment.y and stub.x within segment's x-range. (2026-05-05)

- **DD-11** — Pre-existing-violation tagging in L5: `compact_layout_y_lanes` records pre-L5 violation set; if a post-L5 violation matches a pre-L5 violation, tag it `pre_existing=True, originating_layer=` (heuristic: any violation involving an edge route is L3; involving step box / gate placement is L1). (2026-05-05)

- **DD-12** — Render log: `trace_events` entries already exist; new requirement is consistent layer tagging. Every event gets a `layer: "L1" | "L2" | "L3" | "L4" | "L5" | "L6"` field. Per-figure `debug.log` written when `OPENCODE_GRAFCET_DEBUG=1`. (2026-05-05)

- **DD-13** — Cross-row stub super-grouping (R-12): extend the greedy interval coloring to consider neighbouring gap rows; only merge when no L5 lane budget conflict exists. Implementation lives in `compact_layout_y_lanes`. (2026-05-05)

- **DD-14** — Open question O-1 (right-bus column): resolved by DD-6 above.

- **DD-15** — Open question O-2 (AND converge dot visual): use filled circle + outer hollow ring (visual mirror of AND diverge dot). (2026-05-05)

- **DD-16** — Open question O-3 (1-in-1-out stub side): always lock to the same side as the figure's existing left-bus stub cluster, falling back to right when none exists; tunable in `tweaks.cfg` if needed later. (2026-05-05)

- **DD-17** — Open question O-4 (debug log activation): opt-in via `OPENCODE_GRAFCET_DEBUG=1`; off by default. (2026-05-05)

- **DD-18** — Open question O-5 (CI baselines): redo all baselines as part of this overhaul's verification phase; lock new baselines after Phase 7 visual review. (2026-05-05)

## Risks / Trade-offs

- R-A. **Re-rendering breaks IDEF0/Grafcet validation** for one or more figures. Mitigation: verify each figure individually after Phase 7; capture per-figure waiver if a degradation is identified and accepted.
- R-B. **Right-side bus collides with action boxes** which currently sit on the right. Mitigation: action boxes already have a defined right boundary; right bus lives further right (`max(action_box.right) + GAP`).
- R-C. **DD-7 (1-in-1-out suppression) hides legitimate single-condition gates** that author intended as bars. Mitigation: rule R-4 makes this unconditional; if a future use case wants bars-for-single-condition, it can opt back in via JSON. Currently no such use case exists in any reported figure.
- R-D. **DD-8 (M-in-N-out split) creates an extra layout object** that needs grid plan column allocation. Mitigation: the dummy waypoint between G_c and G_d sits at the shared anchor y; no additional grid_row needed.
- R-E. **Performance regression** from cross-row super-grouping (DD-13). Mitigation: bounded by total stub count, which is small; profiled if needed.
- R-F. **Self-read-image testing is subjective.** Mitigation: define explicit checklist per figure (defect IDs from the table) and confirm each absence; reject if visually new defect appears.

## Critical Files

- `/home/pkcs12/projects/drawmiat/webapp/grafcet_renderer.py` — primary edit target.
- `/home/pkcs12/projects/opencode/specs/*/grafcet.json` — input fixtures (read-only).
- `/home/pkcs12/projects/opencode/specs/*/grafcet.svg` — output, regenerated.
- `/home/pkcs12/projects/opencode/specs/diagrams/*.svg` — centralized mirror, regenerated.
- `/home/pkcs12/projects/opencode/specs/architecture.md` — global SSOT, gets a Grafcet section update referencing this spec.

## Layer Architecture After Overhaul

```
L1: place_step_action_pairs + arrange_transition_gates
    inputs: SemanticGraph
    outputs: LayoutModel with:
      - step_boxes (R-10 figure-uniform width / 3-line height)
      - branch_anchors (R-2 anchor per multi-outgoing step)
      - gates (with 1-in-1-out suppressed per DD-7, M-in-N-out split per DD-8)
      - ports (with exit_dir per DD-1)
      - simplified_gate_ids (per DD-4)
      - condition_stubs (1-in-1-out conditions become stubs)

L3: route_control_edges
    inputs: LayoutModel from L1
    outputs: LayoutModel with edges populated
    contract: every edge starts at port.point, first segment along port.exit_dir;
              right-bus used for forward bypass (DD-6);
              feedback channel slots avoid gate y collisions (R-6.3);
              single dispatcher route_from_anchor (DD-5)

L4: detect_layout_violations
    new check: stub_overlaps_segment (R-8.1)
    new check: M_in_N_out_gate (sanity, should never fire post-DD-8)
    pre-existing tagging (R-9.1) added in cooperation with L5

L5: compact_layout_y_lanes
    cross-row stub super-grouping (R-12, DD-13)
    pre-existing violation surfacing (DD-11)
    no-revert rule for post-violations (R-8.2)

L6: emit_layout_svg
    loses simplification ownership (now reads L1-set simplified_gate_ids)
    keeps label placement, dot/bar selection, stub super-group rendering
    keeps OR/AND visual distinction
    new: writes per-figure debug.log when OPENCODE_GRAFCET_DEBUG=1
```

## Backwards Compatibility

None preserved. The Port schema change is breaking; no consumers of the schema exist outside `grafcet_renderer.py`.

## Telemetry / Debug Log Format

Each `trace_event` becomes:

```json
{
  "layer": "L1",
  "operation": "place_branch_anchor",
  "subject_id": "step:13",
  "details": {"point": {"x": 19.9, "y": 88.0}, "outgoing_count": 2}
}
```

Per-figure `debug.log` is the JSONL form of the trace events in render order, plus a header with figure name, timestamp, and renderer commit hash.
