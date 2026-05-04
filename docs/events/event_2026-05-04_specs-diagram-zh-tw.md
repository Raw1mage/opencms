# Specs Diagram zh-TW Conversion

## 需求

- 將 `specs/` 下所有 IDEF0 與 Grafcet 圖資轉為繁體中文。
- 保留 JSON schema key、ID、StepNumber、ModuleRef、LinkInputType / LinkOutputType 等機器欄位不翻譯。
- 每次重新產圖後用 fileview 開啟供檢查。

## 範圍

IN:

- `specs/**/idef0*.json`
- `specs/**/grafcet*.json`
- 對應 SVG 重新產生與抽查

OUT:

- 非 IDEF0/Grafcet 的 spec 文檔全文翻譯
- 程式碼語意變更

## 任務清單

- [x] 盤點 `specs/` 下 IDEF0/Grafcet JSON 與現有 SVG。
- [x] 批次翻譯圖上可見文字欄位。
- [x] 重新產生受影響 SVG。
- [x] 抽查並記錄驗證結果。

## Checkpoints

- Baseline: active specs 與 archive specs 均存在大量英文 IDEF0/Grafcet source JSON；目前 SVG 也多為英文。
- Boundary: 僅修改圖資 source JSON 的可見文字欄位，保留機器欄位以避免 renderer/schema 破壞。

## Validation

- JSON parse validation: `git diff --name-only -- specs/**/*.json` 範圍內 117 個 JSON 全部可解析。
- SVG regeneration:
  - standard Grafcet: 42 files regenerated.
  - Grafcet subgraphs: 2 files regenerated (`grafcet.step*.svg`).
  - IDEF0: 64 existing target SVGs regenerated through renderer-compatible path.
  - legacy archive compatibility pass: 42 existing archive Grafcet SVGs and 1 legacy IDEF0 SVG regenerated.
- Skip note: 15 archive Grafcet JSON files have no existing `grafcet.svg` target; no new filename was invented for those paths during compatibility pass.
- Sample SVG checks passed: `specs/agent-runtime/grafcet.svg`, `specs/agent-runtime/grafcet.step7.svg`, `specs/webapp/idef0.a0.svg`, `specs/session/grafcet.svg`, `specs/compaction/idef0.a0.svg` are valid SVG text and contain CJK display text.
- Fileview opened for visual spot check:
  - `specs/agent-runtime/grafcet.svg`
  - `specs/agent-runtime/grafcet.step7.svg`
  - `specs/webapp/idef0.a0.svg`
- Follow-up agent-runtime tightening:
  - `specs/agent-runtime/grafcet.json` visible fields rechecked; `StepAction` / `Condition` scan now has 0 `[A-Za-z]{3,}` hits.
  - `specs/agent-runtime/idef0.json` visible fields were retranslated; remaining English hits are intentional technical references such as filenames, APIs, function names, and config keys.
  - Grafcet action boxes remain globally equal width. Width budget is now driven by the widest wrapped text line plus fixed padding: left/right `0.2u`, top/bottom `0.2u`.
  - Current `agent-runtime` Grafcet box budget: width `4.15u`, height `2.86u`; width drivers include steps 3, 5, 7, and 15 with `3.75u` longest lines and `0.40u` total horizontal padding.
  - Regenerated `specs/agent-runtime/grafcet.svg`, `specs/diagrams/agent-runtime.svg`, and `specs/agent-runtime/idef0.a{0,1,2,3,5}.svg`.
  - Validation: `agent-runtime` Grafcet/IDEF0 JSON parse OK; regenerated SVG XML parse OK and contains CJK display text.
- Follow-up agent-runtime L1 branch layout:
  - Root cause: L1 `plan_global_grid()` sorted sibling branch lanes by target step order only, so 6→7/8/9/10 placed 9 between the 7/8/10 group even though 7, 8, and 10 all converge at 11.
  - Fix: L1 branch ordering now groups sibling branches by nearest downstream convergence target before applying horizontal footprint spacing.
  - Fix: L1 keeps multi-input convergence targets anchored by incoming source columns, instead of allowing a single source branch to overwrite the target column.
  - Fix: L1 pushes long bypass transition lanes outward when the planned branch column is already occupied by intermediate rows.
  - Validation: `agent-runtime` now places row-6 branches as 7/8/10/9; 7/8/10 are adjacent and converge to 11. Regenerated `specs/agent-runtime/grafcet.svg` and `specs/diagrams/agent-runtime.svg`.
  - Validation: regenerated SVG XML parse OK; `python3 -m py_compile /home/pkcs12/projects/drawmiat/webapp/grafcet_renderer.py` OK. Renderer still reports 5 warning-level layout violations outside the corrected L1 branch grouping.
- Follow-up Step 5 column correction:
  - Root cause: L1 branch footprint counted downstream fan-in as if it were each branch target's own footprint. For the simple 3→4/5→6 split/merge, this made both 4 and 5 appear width-2 and produced branch offsets `-1, 2`, pushing Step 5 too far right.
  - Fix: L1 branch footprint now only considers the branch target's own forward fan-out; convergence fan-in is handled by convergence anchoring, not branch width.
  - Validation: Step 3 split now places Step 4/5 at columns `-1` and `1`; Step 5 no longer uses column `2`. The 6→7/8/10/9 convergence-aware order remains intact. Regenerated `specs/agent-runtime/grafcet.svg` and `specs/diagrams/agent-runtime.svg`; SVG XML parse and `grafcet_renderer.py` py_compile OK.
- Follow-up generic gate spacing:
  - Requirement: fixes must be renderer-general rules, not Step 8 / Step 11 special cases.
  - Evidence: grep confirmed `grafcet_renderer.py` contains no hard-coded `Step 8`, `Step 11`, `diverge:8`, or `converge:11` handling.
  - Fix: L1 gate slot normalization separates convergence gates from already-allocated diverge/stub slots in the same row gap, then recomputes row gaps and row offsets from the final slot demand.
  - Validation: regenerated `specs/agent-runtime/grafcet.svg` and `specs/diagrams/agent-runtime.svg`; SVG XML parse OK; `grafcet_renderer.py` py_compile OK. Preview confirms Step 8's divergence and the downstream convergence are visually separated by the generic slot/row-gap rule.
- Follow-up split-to-convergence routing:
  - Root cause: L3 routed diverge gate outputs directly to the target step top even when the target also had a convergence gate. In a split-then-merge transition, this made the edge visually turn at the condition/stub lane instead of entering the convergence gate.
  - Fix: L2/L1 gate grouping now allows a transition that belongs to both a source divergence and a target convergence to participate in both gate groups. L3 then routes branch outputs to the target convergence input port before the convergence gate emits the single output to the target step.
  - Validation: 8→11 now targets `gate:converge:11:gate_input:8` instead of `11:top`; regenerated `specs/agent-runtime/grafcet.svg` and `specs/diagrams/agent-runtime.svg`; SVG XML parse OK; `grafcet_renderer.py` py_compile OK.
- Follow-up branch spacing and direct convergence routes:
  - Root cause: L1 branch spacing expanded a sibling group when only one side of an adjacent pair needed multi-lane footprint; this made 6→7/8/10/9 use columns `-4,-1,2,4`.
  - Fix: L1 only applies widened sibling spacing when both adjacent branch footprints need extra lanes; the same group now uses columns `-2,-1,1,2`.
  - Fix: L1 aligns split-to-convergence transitions to the source column, so 8→11 enters `gate:converge:11:gate_input:8` as a straight vertical segment.
  - Fix: L3 routes source→convergence input directly when both ports are already on the same column; 9→12 now routes `(40,57) → (40,76)` instead of using the left bypass lane.
  - Validation: regenerated `specs/agent-runtime/grafcet.svg` and `specs/diagrams/agent-runtime.svg`; SVG XML parse OK; `grafcet_renderer.py` py_compile OK. Renderer diagnostics reduced to 6 warning-level layout violations.
- Follow-up Step 8 divergence lane violation:
  - Root cause: L1 pushed the long 8→14 bypass lane onto a column already used by same-row Step 10 / 10→11 output, and L2 used that distant bypass anchor to size Step 8's divergence bar. This made the Step 8 output gate visually cross into Step 10's column and made `中止訊號已觸發` appear to share the `所有工具結果就緒` lane.
  - Fix: L1 bypass lane avoidance now includes same-source-row peer step columns, not only intermediate rows. L2 also treats cross-row bypass anchors as route lanes, not as local source divergence bar extents, so source divergence bars remain local to their source column.
  - Trace validation: `gate:diverge:8` now has bounds `x=6 width=8`, with both local outputs at `x=10`; `8→14` no longer uses Step 10's `x=30` output lane, while `10→11` remains at `x=30` into `gate:converge:11`.
  - Validation: regenerated `specs/agent-runtime/grafcet.svg` and `specs/diagrams/agent-runtime.svg`; SVG XML parse OK; `grafcet_renderer.py` py_compile OK. Renderer reports 12 warning-level diagnostics pending separate cleanup.
- Follow-up feedforward routing policy:
  - Requirement: cross-row forward feedforward lines such as `8→14` must leave the output port southbound, turn right as early as possible, then descend on a lane chosen to avoid crossing other gate bars before joining the target convergence.
  - Responsibility split: L2/placement owns the feedforward lane policy through `transition_columns`; L3 only consumes the planned lane and emits orthogonal segments.
  - Fix: L3 now consumes the L2-planned transition column for both direct target entry and direct convergence join cases. The route helper emits `south → right to planned lane → down → join`, instead of staying on the source column.
  - Trace validation: `8→14` now routes through points `(10,59) → (10,63) → (50,63) → (50,98) → (10,98)`, while `10→11` remains `(30,57) → (30,65)`.
  - Validation: regenerated `specs/agent-runtime/grafcet.svg` and `specs/diagrams/agent-runtime.svg`; SVG XML parse OK; `grafcet_renderer.py` py_compile OK. Renderer returned `status ok` with 0 diagnostics for the updated active fixture.
- Follow-up mixed output branch junction rule:
  - Requirement: only when one output is associated with two or more targets should the renderer replace the source divergence gate with a named `分叉點`; single-target outputs continue to use the regular gate/track rendering rules.
  - Fix: L2 classifies mixed fan-out sources and emits explicit `BranchJunction` layout objects rendered as hollow circles. L3 consumes those objects by routing `source output → 分叉點` once, then routing each outgoing transition from the branch junction toward its target convergence/feedforward path.
  - Trace validation: `gate:diverge:8` is no longer emitted. L2 places `branch_junction:8` at `(10,59)`. L3 routes `8 output → branch_junction:8`, then `T13` to `gate:converge:11` and `T14` through the right-side feedforward lane.
  - Follow-up route correction: `T14` now starts at the branch junction and turns right immediately: `(10,59) → (50,59) → (50,92) → (10,92) → (10,94)`. This removes the prior extra down-step before the right turn, so the feedforward line visually leaves the hollow branch junction.
  - Generality check: active fixture emits 2 branch junctions (`8`, `12`) because both have output fan-out with mixed convergence/non-convergence targets; single-target outputs do not emit branch junctions.
  - Validation: regenerated `specs/agent-runtime/grafcet.svg` and `specs/diagrams/agent-runtime.svg`; SVG XML parse OK; `grafcet_renderer.py` py_compile OK; SVG contains `class="branch-junction"`; renderer returned `status ok` with 0 diagnostics.
- Follow-up gate port separation:
  - Root cause: L2 placed gate input/output ports directly on the gate bar for both convergence and track gates. L3 therefore emitted horizontal or vertical route segments that visually overlapped the bar/stub, notably `8/12/13 → 14` and `12 → 13`.
  - Rollback: the attempted fix that moved `track` / `or_converge` / `and_converge` input ports above the bar and output ports below the bar was reverted. Visual review showed it broke the global stub continuity and introduced widespread line-segment gaps.
  - Preserved fix: convergence output x still follows the target step center, not the gate bounds center, because that part does not create the stub-discontinuity regression.
  - Validation after rollback: regenerated `specs/agent-runtime/grafcet.svg` and `specs/diagrams/agent-runtime.svg`; SVG XML parse OK; `PYTHONPYCACHEPREFIX=/tmp/drawmiat-pycache python3 -m py_compile /home/pkcs12/projects/drawmiat/webapp/grafcet_renderer.py` OK; renderer returned `status ok` with 0 diagnostics.
- Follow-up conditioned track placement:
  - Requirement: a condition on `12→13` is the entry condition for Step 13, so its track condition bar belongs on the target input vertical segment, not on a short horizontal segment between source and target columns.
  - Root cause: L1 only reserved a `4u` row gap for adjacent `track` transitions, leaving `gate:transition:T18 → 13:top` as a `2u` vertical segment. L2 also centered track gates between source and target columns, putting the condition bar at x `15` while Step 13's input rail is x `10`.
  - Fix: L1 now reserves a larger adjacent-row gap for conditioned `track` transitions. L2 aligns non-feedback `track` gates to the planned transition/target input column.
  - Trace validation: `gate:transition:T18` now has bar center `(10,95)` and `edge:T18:gate-target` routes `(10,95) → (10,99)`, giving the condition bar a `4u` target-input vertical segment into Step 13.
  - Validation: regenerated `specs/agent-runtime/grafcet.svg` and `specs/diagrams/agent-runtime.svg`; SVG XML parse OK; `PYTHONPYCACHEPREFIX=/tmp/drawmiat-pycache python3 -m py_compile /home/pkcs12/projects/drawmiat/webapp/grafcet_renderer.py` OK; renderer returned `status ok` with 0 diagnostics.
- Follow-up branch-junction outgoing route:
  - Root cause: the mixed fan-out rule emitted `branch_junction:12`, but the non-bypass branch `12→13` used a vertical-then-horizontal route from the hollow junction. That shared the x `20` trunk with `12→14` and caused the automatic junction detector to add an extra black point at `(20,95)`.
  - Fix: L3 now routes non-bypass outgoing edges from a branch junction with horizontal-first geometry. This matches the earlier feedforward rule: all outgoing branches visually leave the hollow junction itself instead of first travelling along the shared trunk.
  - Trace validation: `edge:T18:source-gate` now routes `(20,93) → (10,93) → (10,95)`, while `edge:T19:source-gate` remains on the x `20` downward branch. The extra auto junction at `(20,95)` is no longer produced.
  - Validation: regenerated `specs/agent-runtime/grafcet.svg` and `specs/diagrams/agent-runtime.svg`; SVG XML parse OK; `PYTHONPYCACHEPREFIX=/tmp/drawmiat-pycache python3 -m py_compile /home/pkcs12/projects/drawmiat/webapp/grafcet_renderer.py` OK; renderer returned `status ok` with 0 diagnostics.
- Follow-up Step 14 convergence contract:
  - Requirement: Step 14 has three incoming transitions (`8→14`, `12→14`, `13→14`), so L2 must prepare one explicit `or_converge` gate at Step 14's input side with three input ports and one output port. Incoming edges terminate at the gate input ports; only the gate output connects to `14:top`.
  - Rollback: the intermediate attempt to separate convergence input ports by arbitrary offsets was reverted because it reintroduced extra junctions and violated the minimal-turn expectation for `8→14`.
  - Fix: convergence input anchors now use the incoming transition's planned lane only for mixed fan-out sources that already have a hollow branch junction. Ordinary convergence inputs keep their source column. This gives feedforward branches a direct lane into the convergence gate bar without a final bend into the target step.
  - Trace validation: `gate:converge:14` has inputs `8@(50,110)`, `12@(20,110)`, `13@(10,110)` and output `14@(10,110)`. `edge:T14:source-gate` routes `(10,71) → (50,71) → (50,108) → (50,110)` and terminates at `gate:converge:14:gate_input:8`; only `edge:T14:gate-target` connects `gate:converge:14:gate_output:14 → 14:top`.
  - Validation: regenerated `specs/agent-runtime/grafcet.svg` and `specs/diagrams/agent-runtime.svg`; SVG XML parse OK; `PYTHONPYCACHEPREFIX=/tmp/drawmiat-pycache python3 -m py_compile /home/pkcs12/projects/drawmiat/webapp/grafcet_renderer.py` OK; renderer returned `status ok` with 0 diagnostics.
- Follow-up L6 condition label placement:
  - Requirement: L6 text placement should prefer avoiding collisions with existing control-flow lines, and may wrap labels when space allows.
  - Fix: L6 now builds a label obstacle model from rendered edge segments, evaluates condition-label candidate positions on the preferred side, opposite side, above, and below, then selects the lowest-collision placement. Candidate sets include a wrapped two-line form so long condition labels can shrink horizontally when that avoids lines.
  - Guardrail: the default label-to-gate-bar gap remains `1.4u`, preserving the previous safe distance from the condition bar while adding collision-aware alternatives.
  - Validation: regenerated `specs/agent-runtime/grafcet.svg` and `specs/diagrams/agent-runtime.svg`; SVG XML parse OK; `PYTHONPYCACHEPREFIX=/tmp/drawmiat-pycache python3 -m py_compile /home/pkcs12/projects/drawmiat/webapp/grafcet_renderer.py` OK; renderer returned `status ok` with 0 diagnostics.
- Follow-up L6 label repulsion:
  - Requirement: condition labels should also repel each other, not only avoid control-flow lines. If open space exists to the right or left, L6 should move labels horizontally rather than letting text boxes cluster together.
  - Fix: L6 now tracks already placed condition-label bounding boxes and includes them in placement scoring. Candidate positions that overlap or enter the configured repulsion gap around existing labels are penalized, while additional farther horizontal candidates allow labels to move into unused side space.
  - Validation: regenerated `specs/agent-runtime/grafcet.svg` and `specs/diagrams/agent-runtime.svg`; SVG XML parse OK; `PYTHONPYCACHEPREFIX=/tmp/drawmiat-pycache python3 -m py_compile /home/pkcs12/projects/drawmiat/webapp/grafcet_renderer.py` OK; renderer returned `status ok` with 0 diagnostics.
- Architecture Sync: Verified (No doc changes). This task changes diagram language/source render artifacts only; no runtime module boundary, data flow, or state machine semantics changed.
