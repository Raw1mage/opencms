# Normalization Pipeline (drawmiat -> portable miat skill)

## Goal

Transform free-form requirements or repo-derived evidence into stable, renderable JSON artifacts with iterative clarification.

## Pipeline

1. **Entry mode selection**
   - Determine whether the task starts from requirements or an existing repo.
2. **Intent / scope parse**
   - Extract objective, actors, constraints, outputs, target repo/path, and desired decomposition depth.
3. **Evidence collection**
   - For repo mode: read docs/specs/events first, then structural inventory, then code/runtime evidence.
4. **MVP ordering**
   - Determine L1 priority modules by user preference.
5. **Dual decomposition**
   - IDEF0: function/interface structure
   - GRAFCET: dynamic control/state flow
6. **Hierarchy mapping (strict)**
   - Build IDEF0->GRAFCET mapping table (module ID -> state machine scope).
   - Ensure each GRAFCET module references its source IDEF0 module.
   - Enforce IDEF0 numbering convention (`A0`, `A1..A9`, `A11..A19`, ...).
   - Enforce max 9 direct child modules per parent.
7. **Clarification loop**
   - If critical gaps exist, propose options and ask via `mcp_question`.
   - Default upper bound is 12 questions; adjust dynamically with user approval or practical need.
8. **Template instantiation**
   - Start from bundled JSON templates.
9. **Schema validation**
   - Validate against bundled schemas.
10. **Semantic lint**
    - Apply normative profile checks.
11. **ICOM completeness correction**
    - Scan every activity: it MUST have at least one Input arrow AND at least one Output arrow.
    - If an activity has no Input: infer what it transforms from context (parent boundary arrows, sibling outputs, domain knowledge) and add the missing Input arrow. If inference is not possible, add a placeholder and flag in `validation_notes`.
    - If an activity has no Output: infer what it produces and add the missing Output arrow. Same fallback rule.
    - Re-validate arrow IDs for uniqueness after auto-correction.
    - This step runs AFTER semantic lint so that lint can flag the violation first, then this step auto-corrects.
12. **Output write**
    - Save canonical names: `<repo>_a0_idef0.json`, `<repo>_a0_grafcet.json`.
    - Ensure minimum decomposition set includes `a0`, `a1`, `a2` artifacts.
    - For deeper levels, continue with `<repo>_aX_idef0.json` and `<repo>_aX_grafcet.json`.
13. **Trace bundle**
    - Return assumptions, decision trace, validation notes, and repo-mode evidence artifacts.

## Minimum quality gates

- JSON valid
- Every activity has at least one Input arrow AND at least one Output arrow (auto-corrected in step 11)
- IDs consistent and unique
- No undefined transition targets
- Explicit branch conditions
- MVP-first decomposition preserved
- IDEF0 <-> GRAFCET mapping complete (no orphan GRAFCET module)
- IDEF0 numbering format and parent-child chain validity preserved
- No parent activity has 10+ direct children
- Minimum decomposition set (`a0`, `a1`, `a2`) exists
- In repo mode, top-level modules and runtime flows are backed by observable repo evidence
