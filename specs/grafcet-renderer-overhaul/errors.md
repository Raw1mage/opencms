# errors.md — grafcet-renderer-overhaul

## Error Catalogue

### GRAFCET_PORT_EXIT_DIR_UNSET

- **When**: L3 routing consumes a port whose `exit_dir` was not populated by L1.
- **User-visible message**: `port {port.id} consumed without exit_dir; L1 contract violated`.
- **Recovery**: developer fault; raise `GrafcetSemanticError` with the port id; renderer aborts the figure with status=error. No silent fallback.
- **Responsible layer**: L1 (failed to populate); raised at L3.

### GRAFCET_GATE_M_IN_N_OUT_DETECTED

- **When**: L1 attempted to construct a gate with `len(source_ids)>1 AND len(target_ids)>1` and the split (DD-8) failed.
- **User-visible message**: `gate {gate.id} would have arity {M}-in × {N}-out which is illegal per IEC 60848`.
- **Recovery**: log violation, render figure with status=warning; gate omitted from output. Surface via debug.log.
- **Responsible layer**: L1 (validation failure).

### GRAFCET_BRANCH_ANCHOR_DUPLICATE

- **When**: L1 attempted to create a second BranchAnchor for the same step_id.
- **User-visible message**: `step {step_id} already has a branch anchor; duplicate creation refused`.
- **Recovery**: keep first anchor; log info.
- **Responsible layer**: L1.

### GRAFCET_RIGHT_BUS_COLLIDES_ACTION_BOX

- **When**: Computed `right_bus_x` falls inside an action box's x-range.
- **User-visible message**: `right bus column at x={x} overlaps action box {box.id}; check RIGHT_BUS_LANE_GAP`.
- **Recovery**: bump `right_bus_x` past the rightmost action box; emit warning.
- **Responsible layer**: L3.

### GRAFCET_FEEDBACK_CHANNEL_NO_CLEAR_SLOT

- **When**: All channel slots up to a sane upper bound (e.g. 16) collide with gate y-positions in the gap row.
- **User-visible message**: `cannot place feedback channel for {transition.id} without crossing a gate bar; gap row {row} is over-saturated`.
- **Recovery**: log violation, accept the least-bad slot; surface for human review.
- **Responsible layer**: L3.

### GRAFCET_STUB_OVERLAPS_SEGMENT

- **When**: L4 detects a stub at `(x, y)` whose y matches a horizontal route segment's y and x falls within the segment's x-range.
- **User-visible message**: `stub {stub.id} overlaps horizontal segment of {edge.id}; expected to be on disjoint y-tier`.
- **Recovery**: log violation; L5 reverts the compaction step that introduced this if `pre_existing=False`.
- **Responsible layer**: L1 / L5 (placement that allowed the overlap).

### GRAFCET_VISUAL_REVIEW_FINDING

- **When**: Phase 7 self-read-image review surfaces a defect not covered by an existing scenario.
- **User-visible message**: `figure {slug} new visual defect: {description}`.
- **Recovery**: capture in `visual_review.jsonl`; re-open the relevant tasks.md item as `[?]`; iterate.
- **Responsible layer**: meta-process.

### GRAFCET_RENDER_NON_DETERMINISTIC

- **When**: Two consecutive renders of the same figure produce different SVG bytes.
- **User-visible message**: `figure {slug} rendered non-deterministically; check for unordered iteration over dicts/sets`.
- **Recovery**: surface failing input; investigation required.
- **Responsible layer**: any.
