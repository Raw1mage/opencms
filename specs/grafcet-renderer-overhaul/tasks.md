# Tasks — grafcet-renderer-overhaul

Phases run sequentially. Per plan-builder §16, each phase loads its own checklist into TodoWrite at boundary; the agent does not jump phases mid-stream.

**Layer model (authoritative 2026-05-05):** L1 Box+Gate, L2 Routing, L3 Routing Validation, L4 Stub, L5 Balance, L6 Text. Phase numbering below uses the historical layer numbers in already-completed sub-tasks (kept for traceability) but new sub-tasks (2.7+, 2b) reference the new model.

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

## 2. L3 routing cleanup (PRIORITY — user 2026-05-05)

User directive: "最主要的問題是routing的程式還搞不清楚狀況，動不動就分叉合併穿越重疊。不先把routing整理清楚，stub的存在只是來添亂的"

Routing must be cleaned up first. Stub placement (originally Phase 2.x / 3.x) is deferred to a NEW Phase 2b after routing is stable, because without complete clean routes there is no placement basis. "Stub越後放越好" — push to L4 (post-routing). Until 2 is done, do NOT iterate stub placement fixes.

- [-] 2.1 Add `route_from_anchor(start_port, end_port, layout_model, lane_x_provider)` dispatcher — DEFERRED. Existing helpers now consume the corrected port positions (port.point on anchor, exit_drop=0 for diverge feedback) and produce correct routes. The full helper-collapse refactor remains beneficial for code health but no longer blocks defect closure.
- [-] 2.2 Rewrite ternary — DEFERRED for the same reason.
- [-] 2.3 Delete legacy helpers — DEFERRED.
- [x] 2.4 Remove the `effective_gate_output_point` / `is_diverge_feedback` shim — done; routing reads `gate_output.point` which now comes from the BranchAnchor.
- [ ] 2.5 Implement R-6.3 channel slot collision avoidance: when computing channel y, skip slots whose y equals any gate bar y in the gap.
- [x] 2.6 Smoke test: render agent-runtime; T20 route confirmed `[(19.9, 88), (-8, 88), (-8, 43), (19.9, 43)]` — exits anchor west; T19 exits south through bar.
- [ ] 2.7 RCA — re-render all 11 figures and enumerate concrete routing defects (split / merge / cross / overlap), one entry per case in `routing_defects.jsonl`. Classify by layer (port placement / channel y / detour / left-bus / right-bus).
- [ ] 2.8 Resolve every entry in 2.7 by fixing the root layer (ports first, then channel allocation, then detour, then bus). NO stub edits during this phase.
- [ ] 2.9 Re-render all 11 figures; confirm zero entries remaining in `routing_defects.jsonl`. Lock as routing baseline.

## 2b. Big-Batch Refactor (DD-19~25, planned 2026-05-06)

**Scope**: Implements DD-19 through DD-25 in a single coordinated refactor. Earlier sub-phases (2.1-2.6) were defect closures; 2b is the architecture cleanup the user authorized.

User directive 2026-05-06: "你可以更新plan把L1~L6該做的事再整理一遍，然後一次做一票大工程".

### 2b.A — Eliminate `track` Gate type (DD-19)

- [ ] 2b.A.1 In `arrange_transition_gates`, when `gate_key.startswith("transition:")`, do NOT create a Gate object. Skip and let the transition flow as direct step→target/converge edge.
- [ ] 2b.A.2 In `route_control_edges`, when transition has no Gate (gate_key is "transition:Tn"), produce ONE direct edge `edge:T<id>:direct` from source step output to target step input (or target's gate-input port if target has converge).
- [ ] 2b.A.3 Update `_gate_type` enum / signature to drop "track" — only 4 values remain.
- [ ] 2b.A.4 L6 `emit_layout_svg` no longer emits Gate bars for type=track (because no such Gate exists). The condition bar appears via L4 stub.
- [ ] 2b.A.5 Smoke: render all 11 figures; spine connections (T1, T2, T3 etc. in account/agent-runtime) still show condition bars, sourced from L4 stubs.

### 2b.B — L4 Stub Layer (DD-20, DD-21)

- [ ] 2b.B.1 Remove `object_gap_slots[stub:Tx]` reservation block from L1 `plan_global_grid`. L1 no longer pre-reserves stub slots.
- [ ] 2b.B.2 Remove ConditionStub center calc from L3 `route_control_edges`. L3 returns route geometry only.
- [ ] 2b.B.3 Remove stub re-snap fallback from L5 `compact_layout_y_lanes`. L5 only projects through equal-spacing rule.
- [ ] 2b.B.4 Add new function `place_transition_stubs(layout_model) -> LayoutModel` invoked AFTER `route_control_edges` and BEFORE `detect_layout_violations`. For each transition that needs a stub (formerly track gates + converge arms + diverge arms), find its drop segment in the route and create a ConditionStub bound to it.
- [ ] 2b.B.5 Stub center is left UNSET (None) at this point — only `bound_edge_id` and `drop_segment_index` are set. L5 fills in y via equal-spacing.
- [ ] 2b.B.6 Smoke: render all 11 figures; every visible 2u-wide bar with a condition label is a ConditionStub in `layout_model.condition_stubs`.

### 2b.C — L5 Equal-Spacing Universal Rule (DD-21)

- [ ] 2b.C.1 Replace dense_remap heuristic with strict equal-spacing: for each gap_row, list all occupants (boxes-edges, gates, stubs, channels, route lanes), assign each to the next 2u slot in a single sorted pass.
- [ ] 2b.C.2 For each drop segment, list occupants (start endpoint, stubs, end endpoint), enforce 2u between adjacent. Stub.center.y = (slot_index_of_stub + 1) * 2u from start endpoint.
- [ ] 2b.C.3 Remove `channel_only_pullup` heuristic — channels are full participants in equal-spacing now.
- [ ] 2b.C.4 Smoke: agent-runtime gap_row 9 still produces 2u-2u-2u; meta T17 stub now at midpoint of (33.16, 48)→(33.16, 74) drop = y=61 (was y=72).

### 2b.D — L1 Fixpoint Iteration (DD-23, DD-25)

- [ ] 2b.D.1 Wrap `plan_global_grid`'s placement loop in iteration: `while constraints_changed and iter_count < 10`.
- [ ] 2b.D.2 First pass collects "south-detour-required" set: every cross-row transition where source col != target col gets a constraint on source col's downstream rows.
- [ ] 2b.D.3 Second pass: when laying out row N+1, check if row N's column has a south-detour constraint. If yes, reserve detour lane in row N+1's gap (push next box down by 2u).
- [ ] 2b.D.4 Detect convergence: same constraint set as previous iteration → stop.
- [ ] 2b.D.5 Add `_drop_first_constraint(transition)` enforcing source-gate edge starts with south drop in source col (DD-25).
- [ ] 2b.D.6 Smoke: meta T12 (was T17 — depends on figure) source-gate edge starts with south drop, no longer goes north-first.

### 2b.E — L3 Hard Gate (DD-24)

- [ ] 2b.E.1 In `run_repair_loop`, after detour pass + violation re-check, if hard violations remain (cross-box, cross-bar, north-first-detected), trigger L1 re-iteration with violation as new constraint.
- [ ] 2b.E.2 Cap re-iterations at 5; on cap exceeded, raise `GrafcetSemanticError` with violation list. Do NOT return broken layout as warnings.
- [ ] 2b.E.3 L4 (new) and L5 (equal-spacing) must NOT introduce new hard violations; if they do, pre-existing tagging from DD-11 reverts.
- [ ] 2b.E.4 Smoke: any current `Warning: GRAF_LAYOUT_VIOLATION` in the regen logs becomes either a successful render OR a hard error — never a warning + broken figure.

### 2b.F — Bus Convention (DD-22, partial — already in 80% commit)

- [x] 2b.F.1 `_right_lane_x` helper added (commit a049284 in drawmiat).
- [x] 2b.F.2 Routing uses `_right_lane_x` for `is_bypass and not is_feedback`.
- [ ] 2b.F.3 Verify all 11 figures' forward bypasses use right bus. Currently `_right_lane_x` may not trigger because most forward bypasses use `_branch_rail` helpers with different column logic.
- [ ] 2b.F.4 Audit `_branch_rail*` family: for forward bypass cases inside, switch to right_lane_x.

### 2b.G — Final Verification

- [ ] 2b.G.1 Re-render all 11 figures.
- [ ] 2b.G.2 No `GRAF_LAYOUT_VIOLATION` warnings in any figure's render log.
- [ ] 2b.G.3 Visual checklist: no stub on horizontal segment, no bar overlapping route, no route on box edge, no north-first source-gate, no track Gate object.
- [ ] 2b.G.4 Lock as new baseline; commit.

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
