# Proposal: grafcet-renderer-overhaul

## Why

The Grafcet renderer (`/home/pkcs12/projects/drawmiat/webapp/grafcet_renderer.py`) has accumulated a class of recurring rendering defects that resist localized patches. The recurrence pattern is consistent across many figures: feedback lines emerge from gate bar sides, phantom 1-input-1-output gate bars appear between consecutive boxes, dots from consecutive-gate simplification float without connected lines, stubs overlap horizontal segments after L5 compaction, condition labels collide and run off canvas, multi-row bypass routes cross intermediate gate bars.

Diagnosis from this session: **the L1 layer hands L3 a port topology that does not encode route intent**. Every gate output port is at `(per-target-column-x, bar_y)` — a single point that does not indicate which edge (N/S/E/W) the route should exit. L3 then has ten-plus `_*_route` helpers that each re-derive an exit direction from the route's intent (`is_feedback`, `is_bypass`, gate type, etc.) and contort around the wrong port position with `exit_drop` and channel slot offsets. This is why every fix is a corner-case patch and the next figure exposes the same class of bug under a different alignment.

L6's consecutive-gate simplification compounds the problem: it rewrites the **symbol** (gate bar → dot) but leaves the routes untouched, so the dot can end up orphaned with all transitions still anchored to the now-invisible bar's port positions.

The fix is structural: redesign the port contract so L1 places **direction-aware ports** (1-input N-output shared anchor at the column spine, with each output port carrying an explicit exit direction). L3 then becomes a thin walker from port → lane → port. L6's simplification stops being a post-hoc symbol swap and becomes a render-time choice over the same underlying anchor.

## Original Requirement Wording (Baseline)

Verbatim, in chronological order:

1. "在L1的時候是不是就應該預判13下方有分叉點，屬於1input 2output port的共用位置。然後再去routing"
2. "更確切的說我覺得你應該分析一下，是不是整個L1布局要先決定ports，再決定routes。因為每個routes的source/target都必須是一個port"
3. "13-6 應該從空心點左側出發。這是我重複回報了好幾次仍然改不了的問題。RCA"
4. "feedback到6的那條feedback線的起點怎麼會是從gate bar側面出發？這是重複出現的老bug。看一下是哪一層畫錯。"
5. "我們還是把規矩定下來好了。以13的output為例，每兩個box例如13到14之間最多只能出現一個gate"
6. "空心點：分叉點，實心點：匯合點"
7. "我的原意是針對連續gate互接的狀況，去簡化較小的gate"
8. "or dot：單點，and dot：圓點外面再包一圈，例如ⓞ"
9. "json檔中有沒有實質上定義gate物件？還是完全靠程式判斷"
10. "13的output看到的gate就是1 input 1 output gate。沒有這種東西。如果是畫錯，請修改"
11. "14的output又重複出現一個。其他很多圖也重複發生"
12. "mcp.svg有多個重複的bug。不明所以的1-input-1-ouput gate"
13. "meta.svg出現stubs疊在橫線上"
14. "session.svg有橫線和stubs疊在一起。這是違規。剛剛修過了怎麼還會這樣"
15. "compaction.svg的問題很多 — feedback line從gate bar側面發出，起點不明 / 有浮空的stubs，對應關係不明 / 8的input有多餘的匯合點，意義不明"
16. "meta.svg的12的output應該向下向右繞下去。feed forward線是從右邊下去。feedback line是走左邊上去"
17. "回來看agent-runtime這張圖的13，但雖然改了一個分叉點，但是沒有任何線段與它相關"
18. "繪圖系統應該都有做debug.log。你必須追蹤繪圖全程發生bug的節點關鍵所在"
19. "webapp 8，9的 output stubs。說過了字擠可以換行，要避免重疊撞字"
20. "請注意，L6的文字放置演算法要針對空間衝突多一點智慧來避免。例如添加斥力"
21. "新增一個規則。所有gate bar的input line都要有箭頭。箭頭的規則不要套用在stubs上"
22. "Step Box寬度的決定：依照該圖中字最多的Box的三行排列狀況決定寬度"
23. "step box的高度不對。一律三行字高 ... 我剛才的意思是step box裏的文字不必強迫一定要拆三行顯示。但box本身要維持能容納三行字的高度"
24. "你也幫我想一下怎樣智慧地warp文字、縮減step box需求...左右設為0.1u就好"
25. "session.svg算是徹底猜不透要畫什麼。完全不合規"
26. "繪圖json當然要做validation。還有，文字不要為拆行而拆行。真的會觸及margin才拆行"
27. "你要plan就來plan。一次把我所回報的所有問題一次寫成一個大plan"
28. "mcp.svg有多個重複的bug。不明所以的1-input-1-ouput gate"
29. "meta.svg出現stubs疊在橫線上"
30. "plan-builder-sample出現不合規的output line"
31. "session.svg又出現從gate側面出發的線條"
32. "webapp有stubs在L5沒抓到grouping對齊"
33. "compaction.svg中，13 output, 8 output，有不明的穿越現象，那個and gate變成多個input多個output，不合規，看不懂"
34. "請開始連續RCA、連續設計、連續實作、自我讀圖測試、返覆工作"

## Requirement Revision History

- 2026-05-05: initial draft created via plan-init.ts
- 2026-05-05: full backlog of reported defects captured into Effective Requirement Description; structural root cause (port topology) named as the central thesis

## Effective Requirement Description

The renderer must satisfy these binding rules across every figure under `/home/pkcs12/projects/opencode/specs/*/grafcet.svg` and `/home/pkcs12/projects/opencode/specs/diagrams/*.svg`:

### A. Architectural rules (port-first layout)

A1. **L1 决定 ports；L3 follow ports.** Every route's `source` and `target` is a port object created in L1. L3 may not invent effective port positions at routing time. Each port carries `(point, exit_dir ∈ {N, S, E, W})`.

A2. **Branch anchor per multi-outgoing step.** When step S has |outgoing transitions| ≥ 2, L1 places a `BranchAnchor` at `(step_S.col_x, step_S.bottom + ROUTE_CHANNEL_WIDTH)`. This anchor IS:
 - the `gate_input` port for any diverge gate at that row, AND
 - all `gate_output` ports collapse to this single point (one shared geometric anchor), AND
 - the dot symbol when the gate is rendered as a simplified dot, AND
 - the bar's center when the gate is rendered as a full bar.

A3. **Per-route exit direction is fixed by topology, not derived at routing time:**
 - forward, spine column → `S` (south)
 - forward, branch column → `S` then bus
 - feedback (target row ≤ source row) → `W` (west, into left bus)
 - right-side branch (future, optional) → `E`

A4. **Forward bypass uses the right bus; feedback uses the left bus.** Only forward bypass that has no right-side route may fall back to spine column. (Closes meta.svg step 12 output direction complaint.)

A5. **Gate per gap rule.** Between any two consecutive boxes (rows), at most one gate symbol (bar or dot) may appear in the spine column. When two gates compete for the same gap, the smaller-armed gate is rendered as a dot at the shared anchor; the larger-armed gate keeps its bar. (This is the "consecutive gate competition" rule the user established.) The current L6 simplification logic is the seed of this rule but must be promoted to L1 so routing honours the dot anchor.

A6. **No 1-input-1-output gate symbols.** A `track`-type gate that carries a single condition for a single transition must NOT produce a wide bar visually duplicated along the spine. The condition belongs on a stub off the spine, not on a phantom mid-line bar. (Closes mcp.svg step 8/9/10 cluster, agent-runtime step 13/14 spurious bars.)

A6a. **No M-input-N-output AND / OR gate symbols (M>1 AND N>1).** An AND or OR gate per IEC 60848 is either a divergence (1-input, N-outputs) or a convergence (N-inputs, 1-output) — never both at once. If the gate construction logic ever produces a gate object with `len(source_ids) > 1 AND len(target_ids) > 1`, that is a layout error and must be split into one converge + one diverge sharing the same anchor, not rendered as a single ambiguous bar. (Closes compaction.svg D-23.)

A7. **OR vs AND visual distinction (already implemented, formalize).**
 - OR diverge dot: hollow circle (`branch-junction` class, ○)
 - OR converge dot: filled circle (`junction` class, ●)
 - AND diverge dot: hollow circle ringed by a smaller dot (ⓞ)
 - AND converge dot: filled circle ringed by hollow ring (similar style)
 - Wide bars: OR = single line, AND = double line (already correct)

### B. Routing rules

B1. **Feedback exits from anchor's W edge.** Always horizontal at `anchor.y` first; only drop into a numbered channel when ≥ 2 feedback transitions share the same anchor and need lane disambiguation.

B2. **Channel slot collision avoidance.** When a feedback channel y-coordinate would coincide with another gate's bar y, bump the slot index until clear. (Closes the recurring "feedback line emerges from another gate's left side" symptom.)

B3. **Multi-row bypass uses right bus.** A forward transition that skips intermediate rows may not pass through the spine column where intermediate gates live. (Closes T16, T20 bypass-crosses-intermediate-gate.)

B4. **Track gate source-gate fallback already V-then-H.** Keep current behavior (closes meta T17). Verify across all figures.

B5. **Source-gate routes must avoid intermediate step boxes.** Route's H segment may not cross any other step's horizontal extent (current implementation; verify coverage).

B6. **Endpoint-in-bounds skip restricted to port owner.** L4 violation detection only skips the obstacle that owns the route's endpoint port (current implementation; verify).

### C. Compaction rules (L5)

C1. **Stub super-grouping** by greedy interval coloring per gap_row (already implemented). Coverage gap surfaced in webapp (D-22): when adjacent step rows share canonical-y stubs, the per-gap-row scope misses cross-row alignment opportunities. Extension required: super-grouping must also consider canonical-y alignment **across adjacent gap_rows** when no L5 lane budget conflict exists.

C2. **Visible stub IDs filter** when canonicalizing `single_stub_line_gaps` — phantom stubs without `condition_stubs` entries must not contribute to grouping (already implemented).

C3. **Phantom converge groups** must use `forward_target_counts`, not raw `target_counts` (already implemented).

C4. **L5 must not introduce new violations.** When pre/post violation counts are equal but the violation already existed pre-L5, treat as unfixed-but-stable; surface in render log with a `[L5-PRE-EXISTING-VIOLATION]` tag so the upstream layer (L1 / L3) gets blamed correctly.

C5. **Stubs may not overlap horizontal route segments.** A stub at `(x, y)` is forbidden from sharing y with a horizontal segment of any other route within the same gap row. (Closes session.svg, meta.svg regressions.)

### D. Label placement rules (L6)

D1. **Wrap text only when the unwrapped label crosses the canvas margin.** No pre-wrapping for cosmetic reasons (closes "文字不要為拆行而拆行").

D2. **Smart wrap with mid-word fallback** at penalty 2.0 (already implemented). Re-verify the threshold catches the natural-break case before falling through.

D3. **Same-side cluster lock_side rule** (already implemented).

D4. **Repulsion between competing labels** + canvas-edge repulsion (already implemented). Tune so step 6 in app-market.svg's output stub label settles correctly.

D5. **Overlap-area scaled collision score** (already implemented).

D6. **3-line condition max** per stub label (already implemented).

D7. **All gate-bar input lines carry arrow tips. Stubs do not.** (Already implemented; reaffirm as rule.)

### E. Step box sizing (L1)

E1. **Step box width = max over all step boxes in the figure of the width required by a 3-line wrapping of the box's text, plus 0.1u left/right padding.** Even if a particular box's text wraps to fewer lines, the box keeps the figure-uniform width.

E2. **Step box height = 3 lines tall, regardless of how many lines the text actually wraps to.** Text vertically centered.

E3. **Action box** sized independently by its own text; placed to the right of the step box on the same row; not constrained by step box's uniform width.

### F. Validation and observability

F1. **JSON schema validation** for every grafcet input file before rendering (already implemented; verify).

F2. **Render log** (`debug.log` per figure) emits one entry per layer per gate / port / route / stub. Format already exists as `trace_events`; ensure user can grep for `[L3]`, `[L5]`, `[L6]` and locate the layer that produced a specific element of the figure. (Closes "繪圖系統應該都有做debug.log。你必須追蹤繪圖全程發生bug的節點關鍵所在".)

F3. **Pre-merge regression check.** Re-render every figure under `/specs/*/grafcet.json`; diff SVG against a baseline. Fail CI if any baseline figure changes without an explicit waiver entry in the spec's `tasks.md`.

### G. Output artifacts

G1. **Centralized SVG mirror** at `/home/pkcs12/projects/opencode/specs/diagrams/<slug>.svg` for every figure (already in place; verify coverage of all categories — agent-runtime, app-market, attachments, compaction, mcp, meta, plan-builder-sample, provider, session, webapp, and any others under `/specs/`).

G2. **zh-tw event log** at `/home/pkcs12/projects/opencode/docs/events/event_2026-05-04_specs-diagram-zh-tw.md` (already in place; updated as figures change).

## Scope

### IN

- `~/projects/drawmiat/webapp/grafcet_renderer.py` (entire file; structural changes to L1 port topology, L3 routing helpers, L6 simplification, L1 step box sizing).
- Any companion test fixtures under `~/projects/drawmiat/webapp/tests/` (if present).
- Re-rendering and visual review of every figure under `~/projects/opencode/specs/*/grafcet.json` and the centralized mirror.
- Render log format extension if needed for F2.
- JSON schema for grafcet input if validation gaps are found.

### OUT

- IDEF0 renderer (separate skill, separate concerns).
- Webapp UI / API surface around the renderer (only the renderer module).
- Migrating other diagram producers to the new port model (only `grafcet_renderer.py`).
- New figure categories beyond what `/specs/*/grafcet.json` already declares.

## Non-Goals

- Pixel-perfect 1:1 reproduction of pre-overhaul figures. Some routes will move; this is intentional.
- Backwards compatibility with the old `Port = Point` schema. The schema changes; old serialized layout models (if any are persisted) will be invalidated.
- Auto-resolution of every visual conflict. Where two rules conflict, surface a `[CONFLICT]` violation and leave the figure in a known-degraded state for human review rather than guessing.

## Constraints

- The renderer is a pure-Python module; no external CAS or layout solver. All algorithms must remain in Python with the existing dependency footprint.
- Performance target: render any single figure in ≤ 1s on the development machine. Current code is well within this; the overhaul should not regress.
- Existing IEC 60848 grafcet rules (conditions on transitions, OR/AND fork semantics) remain the authority. The overhaul changes layout, not semantics.
- Existing diagram input JSON shape (`StepNumber` / `LinkInputType` / `LinkOutputType` / etc.) is fixed; the renderer adapts to whatever the JSON declares.
- Re-render parity check requires every existing figure to either render correctly OR have its degradation explicitly waived in tasks.md.

## What Changes

Layer-by-layer change inventory:

- **L1 (`place_step_action_pairs`, `arrange_transition_gates`)**:
 - Step box width: figure-uniform, derived from widest 3-line wrap (E1).
 - Step box height: always 3-line capacity, text centered (E2).
 - New `BranchAnchor` placement for any step with ≥ 2 outgoing transitions (A2). Generalizes current `_mixed_output_junction_sources` to all multi-outgoing cases.
 - `Port` schema gains `exit_dir: Literal["N","S","E","W"]`. All `_gate_port` calls updated.
 - Gate output ports for a divergence collapse to the BranchAnchor point; per-target distinction is via `exit_dir`, not via per-target x.
 - Consecutive-gate simplification (currently L6) promoted to L1. The `simplified_gate_ids` set, the dot anchor location, and the OR/AND visual class are all decided here.
 - 1-in-1-out track gate guard: if a track gate has exactly 1 source, 1 target, and lives on the spine where its parent step's box already provides the line, suppress the bar; route the condition to a stub instead (A6).

- **L3 (`route_control_edges`)**:
 - Route helpers consolidated. `_feedback_top_entry_route`, `_feedback_input_join_route`, `_forward_bypass_top_entry_route`, `_branch_rail_*`, `_feedforward_branch_rail_*` collapse into a single `route_from_anchor(start_port, target_port, lane_x)` that walks `start_port.point` → `start_port.exit_dir` → lane → `target_port.point` from `target_port.exit_dir`.
 - Channel slot collision-with-gate-y avoidance built into the lane allocation (B2).
 - Multi-row bypass uses right bus (B3) — new lane allocation for right-side routes.

- **L4 (`detect_layout_violations`)**:
 - Pre-existing violation tagging (C4): when L5 reverts due to no improvement, surface the pre-existing violation with explicit blame to L1 / L3.
 - Stub-on-horizontal-segment check (C5).

- **L5 (`compact_layout_y_lanes`)**:
 - No new behaviour; verify all existing fixes hold under the new port topology.

- **L6 (`emit_layout_svg`)**:
 - Loses ownership of consecutive-gate simplification (now in L1).
 - Keeps label placement, stub super-grouping rendering, dot-vs-bar selection (driven by L1's decision).
 - Verifies stubs do not overlap horizontal segments (cooperates with C5 violation check).

- **F2 render log**:
 - `[GRAFCET-RENDER]` prefix on every layer trace event.
 - Per-figure `debug.log` written alongside the SVG when `OPENCODE_GRAFCET_DEBUG=1` (or equivalent).

## Capabilities

### New Capabilities

- **Direction-aware port contract.** Every port carries (point, exit_dir). Routing is a port-walk, not a contortion algorithm.
- **Branch anchor as 1st-class object.** Multi-outgoing step gets a single shared geometric anchor that all routes start from; the dot OR bar is just a rendering of this anchor.
- **L1-owned consecutive-gate simplification.** Routing knows about the dot from the start, so simplified dots are never orphaned and never produce gate-side feedback exits.
- **Right-side bus for forward bypass.** Forward bypass and feedback no longer compete for the same left lane.
- **1-in-1-out gate suppression.** Phantom track gate bars between consecutive boxes are eliminated; the condition becomes a stub.
- **Stub-on-horizontal-segment violation check.** L4 catches the regression class that has resurfaced in session.svg and meta.svg.
- **Pre-existing-violation tagging.** L5 cannot hide an L3 / L1 bug behind a no-improvement no-revert outcome.
- **Per-figure debug log.** Every layer's contribution to a specific element is greppable.

### Modified Capabilities

- **`Port` dataclass** gains `exit_dir`. All consumers updated.
- **`Gate` output_ports semantics** for diverge gates: all collapse to anchor point; distinguish by exit_dir.
- **`_gate_key` and the gate construction machinery** simplified now that 1-in-1-out track gates are suppressed.
- **`_feedback_top_entry_route` and the helper zoo** consolidated into `route_from_anchor`.
- **L6 simplification block** reduced to "render the L1-decided symbol".
- **Step box width computation** rewritten to figure-uniform-3-line-wrap-max.
- **Step box height computation** rewritten to fixed 3-line capacity with text centered.

## Impact

- **Code:** ~2000+ lines of `grafcet_renderer.py` touched; layer boundaries shift but file structure preserved.
- **Existing SVG output:** ALL figures will be re-rendered. Routes will move. The visual review pass per figure is mandatory.
- **JSON inputs:** unchanged.
- **Documentation:** `/specs/architecture.md` — Grafcet renderer section needs an entry pointing at the new port contract. Existing zh-tw event log at `/docs/events/event_2026-05-04_specs-diagram-zh-tw.md` gains a follow-up entry.
- **Skill cross-link:** `miatdiagram` skill at `/home/pkcs12/projects/skills/miatdiagram/` references the renderer; verify no skill doc claims something the new contract violates.
- **Test fixtures:** if present under `~/projects/drawmiat/webapp/tests/`, golden SVGs need refresh; this is the explicit baseline-update event.
- **Operators / users:** none directly; downstream consumers see corrected figures only.

## Currently Reported Defects (for cross-reference into spec.md / tasks.md)

| ID | Figure | Symptom | Layer suspected | Closed by rule |
|---|---|---|---|---|
| D-01 | agent-runtime | T20 feedback emerges from converge:14 left side instead of diverge:13 dot | L3 routing + L1 port topology | A1, A2, B1, B2 |
| D-02 | agent-runtime | dot below box 13 has no connected line | L6 simplification orphaned dot | A2, A5 |
| D-03 | agent-runtime | spurious 1-in-1-out gate at step 13/14 output | L1 gate construction | A6 |
| D-04 | mcp | multiple 1-in-1-out gate clusters between steps 8/9/10 | L1 gate construction | A6 |
| D-05 | mcp | feedback on gate bar | L3 routing | B1, B2 |
| D-06 | mcp | neighbor-line carrying 2 stubs | L5 + L6 grouping | C1, C2 |
| D-07 | meta | step 12 forward output goes left-up instead of down-right | L3 lane selection | A4, B3 |
| D-08 | meta | stubs overlapping horizontal lines | L5 + L4 missing check | C5 |
| D-09 | session | stubs overlapping horizontal lines (regression) | L5 + L4 missing check | C5 |
| D-10 | session | unrenderable / unparsable layout | L1 ~ L6 | covered by overhaul |
| D-11 | compaction | feedback line from gate side | L3 + L1 port topology | A1, A2, B1 |
| D-12 | compaction | floating stubs without correspondence | L5 phantom canonicalization | C2 |
| D-13 | compaction | step 8 input has redundant junction | L3 collinear midpoint | already fixed; verify |
| D-14 | compaction | 3→4 line drawn non-canonically | L5 compression | C4 (pre-existing-violation tagging) |
| D-15 | webapp | step 8/9 output stub labels overlap | L6 label placement | D1, D2, D4 |
| D-16 | app-market | step 6 output stub label position off | L6 label placement | D4 |
| D-17 | attachments | step box too wide | L1 sizing | E1 |
| D-18 | plan-builder-sample | many abnormalities | mixed | covered by overhaul |
| D-19 | provider | (verify) | mixed | covered by overhaul |
| D-20 | plan-builder-sample | step 1 output line non-compliant: lines branch off the spine into the left bus area without an anchor / gate symbol; conditions appear floating mid-bus | L1 anchor placement + L3 routing | A1, A2, A5 |
| D-21 | session | recurring feedback line emerging from gate bar side (same class as D-01, D-05, D-11) | L3 routing + L1 port topology | A1, A2, B1, B2 |
| D-22 | webapp | stubs across adjacent step rows are not grouped/aligned by L5 super-grouping when the same canonical y is shared | L5 super-grouping coverage | C1, C2 |
| D-23 | compaction | step 13 / step 8 outputs produce AND gate bars that appear with multi-input AND multi-output (M-in-N-out) — non-compliant per IEC 60848; symbol is unintelligible | L1 gate construction (illegal arity combination) | A6a |

## Open Questions for Design Phase

1. Right-side bus column: where exactly does it live in column coordinates? Symmetric with left bus at `LEFT_BUS_LANE_GAP` to the right of `max(step_box.right)`?
2. AND converge dot visual: filled-then-ringed-with-hollow-ring, or a different convention? Confirm IEC 60848 reference.
3. 1-in-1-out track gate suppression: does the condition stub go on the spine or off to the side? If off to the side, which side wins (alternating per row, or always one side)?
4. Render log activation: opt-in env var only, or always-on with a configurable verbosity? (Cost: zh-tw figure batch produces ~10 figures × O(thousand) trace events = ~10MB.)
5. CI baseline waivers: do we lock all current SVGs as baselines and require explicit per-figure waiver, or do we redo baselines as part of this overhaul's verification phase and accept the new versions as the new baseline?

## Resolution Path

1. Promote to `designed`. Author `spec.md` (per-rule scenarios with GIVEN/WHEN/THEN), `design.md` (decisions on the open questions, port contract data structure), `c4.json` (layer C-numbers), `sequence.json` (request → render flow), `data-schema.json` (Port / Gate / BranchAnchor fields), `idef0.json` + `grafcet.json` (the renderer's own functional decomposition, via miatdiagram skill).
2. Promote to `planned`. Author `tasks.md` with phases per layer (L1 port refactor → L3 routing collapse → L1 simplification migration → L4 new violation checks → L1 step box sizing → render log → re-render and visual review). `handoff.md` lists the per-figure regression baseline.
3. Promote to `implementing`. Execute phase by phase; per §16 of plan-builder, TodoWrite materializes one phase at a time.
4. Promote to `verified`. All figures re-rendered; per-figure visual sign-off recorded.
5. Promote to `living`. Merge.
