# Normalization Pipeline (drawmiat -> portable miat skill)

## Goal

Transform free-form requirements into stable, renderable JSON artifacts with iterative clarification.

## Pipeline

1. **Intent parse**
   - Extract objective, actors, constraints, outputs.
2. **MVP ordering**
   - Determine L1 priority modules by user preference.
3. **Dual decomposition**
   - IDEF0: function/interface structure
   - GRAFCET: dynamic control/state flow
4. **Hierarchy mapping (strict)**
   - Build IDEF0->GRAFCET mapping table (module ID -> state machine scope).
   - Ensure each GRAFCET module references its source IDEF0 module.
   - Enforce IDEF0 numbering convention (`A0`, `A1..A9`, `A11..A19`, ...).
   - Enforce max 9 direct child modules per parent.
5. **Clarification loop**
   - If critical gaps exist, propose options and ask via `mcp_question`.
   - Default upper bound is 12 questions; adjust dynamically with user approval or practical need.
6. **Template instantiation**
   - Start from bundled JSON templates.
7. **Schema validation**
   - Validate against bundled schemas.
8. **Semantic lint**
   - Apply normative profile checks.
9. **Output write**
   - Save canonical names: `<repo>_a0_idef0.json`, `<repo>_a0_grafcet.json`.
   - Ensure minimum decomposition set includes `a0`, `a1`, `a2` artifacts.
   - For deeper levels, continue with `<repo>_aX_idef0.json` and `<repo>_aX_grafcet.json`.
10. **Trace bundle**
    - Return assumptions, decision trace, and validation notes.

## Minimum quality gates

- JSON valid
- IDs consistent and unique
- No undefined transition targets
- Explicit branch conditions
- MVP-first decomposition preserved
- IDEF0 <-> GRAFCET mapping complete (no orphan GRAFCET module)
- IDEF0 numbering format and parent-child chain validity preserved
- No parent activity has 10+ direct children
- Minimum decomposition set (`a0`, `a1`, `a2`) exists
