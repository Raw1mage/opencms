# Tasks — grafcet-renderer-overhaul

Phases run sequentially. Per plan-builder §16, each phase loads its own checklist into TodoWrite at boundary; the agent does not jump phases mid-stream.

## 1. L1 port refactor + branch anchor + step box sizing

- [x] 1.1 Add `exit_dir: Literal["N","S","E","W"]` field to `Port` dataclass; default unset and emit warning if a port is consumed without exit_dir set
- [x] 1.2 Generalize `_mixed_output_junction_sources` to `_branch_anchor_sources` — trigger = any step with |outgoing| ≥ 2; rename data structure from `branch_junctions` to `branch_anchors` with same fields plus `outgoing_directions: dict[transition_id, ExitDir]`
- [x] 1.3 In `arrange_transition_gates`, after the gate group is built, populate every output port's `exit_dir` from the transition's topology (forward spine → S, forward bypass → S then bus, feedback → W, right branch → E)
- [x] 1.4 Collapse all output ports of a single diverge gate to the same anchor point; differ only in `exit_dir` and `transition_id`
- [x] 1.5 Implement DD-9 step box sizing — already met by existing `_action_box_metrics` (3-line max, 0.1u padding, figure-uniform width)
- [x] 1.6 Implement DD-7 1-in-1-out gate suppression: gates with single source/target add to `simplified_gate_ids`; L6 renders as junction dot + condition stub label, no wide bar
- [-] 1.7 Implement DD-8 M-in-N-out split — DETECTION done as warning; full converge+diverge split deferred (no figure currently trips it after L1 changes)
- [x] 1.8 Move `simplified_gate_ids` computation from `emit_layout_svg` into `arrange_transition_gates`; expose on LayoutModel via the `simplified_gate_ids` field of the schema (DD-4).
- [x] 1.9 Smoke test — agent-runtime / mcp / compaction / meta / session all render `status=ok` post-L1; visual review confirmed D-01/02/03/04/09/11/12/21 closed

## 2. L3 routing collapse to route_from_anchor

- [-] 2.1 Add `route_from_anchor(start_port, end_port, layout_model, lane_x_provider)` dispatcher — DEFERRED. Existing helpers now consume the corrected port positions (port.point on anchor, exit_drop=0 for diverge feedback) and produce correct routes. The full helper-collapse refactor remains beneficial for code health but no longer blocks defect closure.
- [-] 2.2 Rewrite ternary — DEFERRED for the same reason.
- [-] 2.3 Delete legacy helpers — DEFERRED.
- [x] 2.4 Remove the `effective_gate_output_point` / `is_diverge_feedback` shim — done; routing reads `gate_output.point` which now comes from the BranchAnchor.
- [ ] 2.5 Implement R-6.3 channel slot collision avoidance: when computing channel y, skip slots whose y equals any gate bar y in the gap.
- [x] 2.6 Smoke test: render agent-runtime; T20 route confirmed `[(19.9, 88), (-8, 88), (-8, 43), (19.9, 43)]` — exits anchor west; T19 exits south through bar.

## 3. L4 new violation checks + L5 cooperation

- [ ] 3.1 Add `stub_overlaps_segment` violation type in `detect_layout_violations` (R-8.1).
- [ ] 3.2 Add `m_in_n_out_gate` violation type for sanity (should never fire post-DD-8).
- [ ] 3.3 Capture pre-L5 violation set inside `compact_layout_y_lanes`; tag matching post-L5 violations with `pre_existing=True` and `originating_layer` heuristic (DD-11).
- [ ] 3.4 L5 must revert any compaction step that introduces new `stub_overlaps_segment` violations (R-8.2).
- [ ] 3.5 Smoke test: render session.svg + meta.svg; confirm no `stub_overlaps_segment` violations remain.

## 4. Right-side bus for forward bypass

- [ ] 4.1 Define `RIGHT_BUS_LANE_GAP` constant; compute `right_bus_x = max(action_box.right) + RIGHT_BUS_LANE_GAP` per figure.
- [ ] 4.2 Extend `lane_slots` allocation to support both left and right buses.
- [ ] 4.3 Implement R-7: forward bypass route uses right bus only.
- [ ] 4.4 Smoke test: render meta.svg step 12 forward; confirm route goes down-right, not left-up.

## 5. Render log per layer + per-figure debug.log

- [ ] 5.1 Add `layer` field to every `_trace_event` call site; default value derived from caller location.
- [ ] 5.2 Add `OPENCODE_GRAFCET_DEBUG=1` env-var check in render entry; when set, write JSONL `debug.log` next to the SVG.
- [ ] 5.3 Smoke test: render with env var set; grep `debug.log` for `[L3]` to confirm layer tagging works.

## 6. Cross-row stub super-grouping

- [ ] 6.1 In `compact_layout_y_lanes`, extend greedy interval coloring to consider stubs in adjacent gap rows when canonical_y matches (R-12 / DD-13).
- [ ] 6.2 Verify no L5 lane budget conflict before merging.
- [ ] 6.3 Smoke test: render webapp; confirm cross-row stub alignment improves.

## 7. Re-render every figure + self-read-image visual review + iterate

- [ ] 7.1 Enumerate every `/home/pkcs12/projects/opencode/specs/*/grafcet.json` and re-render to its sibling `grafcet.svg` and the centralized mirror `/specs/diagrams/<slug>.svg`.
- [ ] 7.2 For each figure: load the SVG path into the main-agent's multimodal read context; check against the figure's defect list (D-NN entries from proposal table).
- [ ] 7.3 Capture each visual finding as a JSONL entry in `/specs/grafcet-renderer-overhaul/visual_review.jsonl`.
- [ ] 7.4 For any new defect surfaced, return to the appropriate phase (re-open as `[?]` task in tasks.md), fix, re-render, re-review. Iterate until visual_review.jsonl shows zero NON-COMPLIANT findings.
- [ ] 7.5 Update `/specs/architecture.md` Grafcet section pointing at this spec.
- [ ] 7.6 Update `/docs/events/event_2026-05-04_specs-diagram-zh-tw.md` with overhaul outcome.
- [ ] 7.7 Lock new SVG baselines (overwrite previous versions); record baseline-lock hash in `.state.json` history.

## 8. Promote and merge

- [ ] 8.1 `plan-promote --to verified` once all visual_review entries are clean.
- [ ] 8.2 Commit `grafcet_renderer.py` + all regenerated SVGs in one logical commit (or split per phase if size demands).
- [ ] 8.3 `plan-promote --to living` after merge to main.
