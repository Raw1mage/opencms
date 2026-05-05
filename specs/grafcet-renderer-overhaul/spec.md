# spec.md — grafcet-renderer-overhaul

## Purpose

Make `grafcet_renderer.py` a self-consistent layered system where every reported defect class (D-01 to D-23) is structurally impossible, not just patched-around. The structural lever is making **L1 ports a directional contract** so L3 routing has nothing to guess.

## Requirements

### Requirement: Direction-aware port contract (R-1)

Every Port carries an explicit exit direction. L3 routing must consume `port.exit_dir` rather than re-derive it from route topology.

#### Scenario: diverge gate output port for a feedback transition (R-1.1)

- **GIVEN** a step S at row R has 2+ outgoing transitions and one of them, T, targets a step at row ≤ R (feedback)
- **WHEN** L1 places ports on the diverge gate covering S
- **THEN** T's gate_output port has `exit_dir = "W"` and `point = (S.col_x, anchor_y)` where `anchor_y = S.bounds.bottom + ROUTE_CHANNEL_WIDTH`

#### Scenario: diverge gate output port for a forward spine transition (R-1.2)

- **GIVEN** a step S at row R has 2+ outgoing transitions and one of them, T, targets row R+1 in the same column
- **WHEN** L1 places ports on the diverge gate
- **THEN** T's gate_output port has `exit_dir = "S"` and `point = (S.col_x, anchor_y)`

#### Scenario: diverge gate output port for a forward bypass transition (R-1.3)

- **GIVEN** a step S at row R has an outgoing transition T to a step at row > R+1 (bypass)
- **WHEN** L1 places ports on the diverge gate
- **THEN** T's gate_output port has `exit_dir = "S"` and `point = (S.col_x, anchor_y)`, with the route subsequently directed through the right-side bus by L3 (per R-7)

#### Scenario: L3 never overrides effective port position (R-1.4)

- **GIVEN** any transition T with source port P
- **WHEN** L3 builds the route for T
- **THEN** the route starts at exactly `P.point` and the first segment is along `P.exit_dir`; L3 does not introduce an `effective_gate_output_point` or similar override

### Requirement: Branch anchor as 1st-class object (R-2)

Multi-outgoing steps share a single geometric anchor at the spine column.

#### Scenario: anchor exists for any |outgoing|≥2 step (R-2.1)

- **GIVEN** step S has 2+ outgoing transitions
- **WHEN** L1 layout completes
- **THEN** `layout_model.branch_anchors` contains an entry with `step_id = S.id` and `point = (S.col_x, S.bottom + ROUTE_CHANNEL_WIDTH)`

#### Scenario: dot is rendered at anchor when gate is simplified (R-2.2)

- **GIVEN** step S's diverge gate is in `simplified_gate_ids`
- **WHEN** L6 emits SVG for the gate
- **THEN** the dot circle is placed exactly at `branch_anchors[S.id].point` — not at `step_x_by_id[anchor_id]` derived at L6

#### Scenario: bar center coincides with anchor when gate is full (R-2.3)

- **GIVEN** step S's diverge gate is rendered as a bar
- **WHEN** L6 emits SVG for the gate
- **THEN** the bar's geometric center y equals `branch_anchors[S.id].point.y`

### Requirement: Per-gap one-gate rule (R-3)

Between any two consecutive boxes (rows), at most one gate symbol may appear in the spine column.

#### Scenario: simplification when two gates share a gap (R-3.1)

- **GIVEN** a diverge gate G_d at gap row R and a converge gate G_c at the same gap row R, with a transition T directly connecting them (G_d.target_id == G_c.source_id for some shared transition)
- **WHEN** L1 simplification runs
- **THEN** the smaller-armed gate (lesser of `len(source_ids)+len(target_ids)`) is added to `simplified_gate_ids`; the larger keeps its bar; ties go to the diverge

#### Scenario: simplification decision is made at L1, not L6 (R-3.2)

- **GIVEN** L1 has finished simplification decisions
- **WHEN** L3 runs routing
- **THEN** L3 reads `simplified_gate_ids` and treats the simplified gate's port as the anchor point (no bar to clear), without recomputing the simplification rule

### Requirement: No phantom 1-in-1-out gate symbols (R-4)

A track-type gate carrying a single condition for a single transition shall not produce a wide bar in the spine.

#### Scenario: single-condition single-transition gate (R-4.1)

- **GIVEN** a track gate G with `len(source_ids) == 1`, `len(target_ids) == 1`, and a single condition string
- **WHEN** L1 constructs gates
- **THEN** G is not emitted as a wide bar; instead its condition is attached as a stub off the spine line

#### Scenario: single-arm divergence is also suppressed (R-4.2)

- **GIVEN** any gate G where `len(source_ids) == 1 AND len(target_ids) == 1`
- **WHEN** L1 constructs gates
- **THEN** G is not emitted as any bar shape (single, double, or otherwise); the condition becomes a stub

### Requirement: No M-in-N-out illegal gates (R-5)

#### Scenario: detection of illegal arity combination (R-5.1)

- **GIVEN** L1 attempts to emit a gate G with both `len(source_ids) > 1` AND `len(target_ids) > 1`
- **WHEN** L1 validates gate arities
- **THEN** L1 splits G into one converge (N-in-1-out) plus one diverge (1-in-N-out) sharing a single anchor; both share the same y; one renders as bar, the other as dot per R-3

### Requirement: Feedback exits anchor's W edge (R-6)

#### Scenario: single feedback from anchor (R-6.1)

- **GIVEN** anchor A has exactly one outgoing feedback transition T
- **WHEN** L3 routes T
- **THEN** the route is `[A.point, (lane_x, A.point.y), (lane_x, target_entry_y), (target_box.col_x, target_entry_y), target.point]` with no vertical drop near A

#### Scenario: multiple feedback from same anchor (R-6.2)

- **GIVEN** anchor A has 2+ outgoing feedback transitions T1, T2
- **WHEN** L3 routes them
- **THEN** each gets a distinct `lane_x` so their vertical bus segments do not overlap; horizontal segments at `A.point.y` are not stacked (use channel slot bumping per R-7)

#### Scenario: feedback channel slot avoids gate-y collision (R-6.3)

- **GIVEN** a feedback channel y `cy = A.point.y + slot * ROUTE_CHANNEL_WIDTH` would equal the bar y of another gate G' in the same gap row
- **WHEN** L3 picks the slot
- **THEN** slot is incremented until `cy` is clear of all gate bar y-coordinates in the gap

### Requirement: Forward bypass uses right bus (R-7)

#### Scenario: bypass route has no left-bus crossing (R-7.1)

- **GIVEN** a forward transition T from row R_s to row R_t where R_t > R_s + 1 (bypass)
- **WHEN** L3 routes T
- **THEN** the route's horizontal segments live at `x ≥ rightmost_step_box.right + RIGHT_BUS_LANE_GAP`; no horizontal segment crosses the spine column at intermediate rows

#### Scenario: forward output exits anchor S then hooks east (R-7.2)

- **GIVEN** anchor A has a forward bypass transition T
- **WHEN** L3 routes T
- **THEN** the first segment is south from A.point to `(A.point.x, A.point.y + bus_drop)`, then east to right bus, then south, then west into target's input port

### Requirement: Stub-on-segment violation check (R-8)

#### Scenario: L4 detects stub overlapping a horizontal route segment (R-8.1)

- **GIVEN** any condition stub at `(x, y)` and any horizontal route segment with `y_seg == y` and `x` ∈ segment's x-range
- **WHEN** L4 runs detect_layout_violations
- **THEN** a violation `stub_overlaps_segment` is emitted, target_ids include both the stub and the segment owner

#### Scenario: L5 must not produce post-compaction stub overlaps (R-8.2)

- **GIVEN** a layout with no `stub_overlaps_segment` violations pre-L5
- **WHEN** L5 compacts
- **THEN** the post-L5 layout has no `stub_overlaps_segment` violations either; if it does, L5 reverts the compaction step that introduced it

### Requirement: Pre-existing-violation tagging (R-9)

#### Scenario: L5 surfaces pre-existing violation rather than masking it (R-9.1)

- **GIVEN** the pre-L5 violation set contains V and the post-L5 violation set also contains V
- **WHEN** L5 finishes compaction
- **THEN** the violation V is tagged with `pre_existing = True` and `originating_layer ∈ {L1, L3}` so the user / debug log can see L5 is not the cause

### Requirement: Step box sizing rules (R-10)

#### Scenario: figure-uniform width based on widest 3-line wrap (R-10.1)

- **GIVEN** N step boxes in a single figure with text strings `texts = [...]`
- **WHEN** L1 determines step box width
- **THEN** `width = max(over t in texts of width_for_3_line_wrap(t)) + 0.2u` (0.1u left + 0.1u right padding); all step boxes share this width

#### Scenario: 3-line height regardless of actual wrap (R-10.2)

- **GIVEN** a step box B
- **WHEN** L1 determines B's height
- **THEN** `height = 3 * line_height + vertical_padding`; text is vertically centered within the box even when text wraps to fewer than 3 lines

#### Scenario: text wraps only when natural width exceeds box capacity (R-10.3)

- **GIVEN** text `t` whose unwrapped natural width fits in `box_width - 0.2u`
- **WHEN** L1 lays out the text
- **THEN** `t` renders on a single line; no preemptive wrapping for cosmetic vertical centering

### Requirement: Label placement intelligence (R-11)

#### Scenario: same-side cluster lock_side already implemented (R-11.1)

- **GIVEN** N stubs at the same canonical y participate in a super-group
- **WHEN** L6 places condition labels
- **THEN** all N labels lock to the same side (left or right) determined by least-collision side selection

#### Scenario: canvas-edge repulsion already implemented (R-11.2)

- **GIVEN** a candidate label position would extend past the canvas margin
- **WHEN** L6 picks label anchor
- **THEN** the candidate's collision score is penalized so it is rejected in favor of an in-canvas alternative

#### Scenario: 3-line maximum per condition label (R-11.3)

- **GIVEN** a condition string longer than fits on 3 lines
- **WHEN** L6 wraps it
- **THEN** the label is truncated with ellipsis at line 3, and the full text is captured in a `truncated_label` violation for human review

### Requirement: Cross-row stub super-grouping (R-12)

#### Scenario: stubs sharing canonical-y across gap rows are aligned (R-12.1)

- **GIVEN** stubs S1 in gap row R1 and S2 in gap row R2 both have `canonical_y = Y`, and there is no L5 lane budget conflict
- **WHEN** L5 super-grouping runs
- **THEN** S1 and S2 are placed in the same super-group with `align_y = Y`; their condition labels lock to the same side

### Requirement: Render log per layer (R-13)

#### Scenario: every gate / port / route / stub records its originating layer (R-13.1)

- **GIVEN** the renderer runs with debug logging enabled
- **WHEN** L1, L2 (arrange_transition_gates), L3, L4, L5, L6 each finish
- **THEN** the trace_events list contains entries tagged `[L1]`, `[L2]`, `[L3]`, `[L4]`, `[L5]`, `[L6]` describing every layout element produced or modified by that layer

#### Scenario: per-figure debug.log written alongside the SVG (R-13.2)

- **GIVEN** environment variable `OPENCODE_GRAFCET_DEBUG=1`
- **WHEN** the renderer writes a figure
- **THEN** a sibling `debug.log` file is written next to the SVG containing the trace events in greppable form

## Acceptance Checks

A figure is "correctly rendered" when ALL of the following hold (no manual exception is acceptable):

1. Every reported defect from the proposal's defect table is absent from this figure.
2. Every required Scenario above passes for the elements present in the figure.
3. The post-L5 violation set is empty for this figure (or every remaining violation is explicitly waived in tasks.md with a written justification).
4. Re-rendering the figure produces an SVG byte-identical to the previous run (deterministic output).
5. Visually reviewing the figure (main agent reads the SVG as image) yields no `[NON-COMPLIANT]` or `[CONFUSING]` finding.
