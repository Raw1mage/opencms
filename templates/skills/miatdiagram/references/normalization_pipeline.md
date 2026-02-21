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
4. **Clarification loop**
   - If critical gaps exist, propose options and ask via `mcp_question`.
5. **Template instantiation**
   - Start from bundled JSON templates.
6. **Schema validation**
   - Validate against bundled schemas.
7. **Semantic lint**
   - Apply normative profile checks.
8. **Output write**
   - Save `<name>_idef0.json` and `<name>_grafcet.json`.
9. **Trace bundle**
   - Return assumptions, decision trace, and validation notes.

## Minimum quality gates

- JSON valid
- IDs consistent and unique
- No undefined transition targets
- Explicit branch conditions
- MVP-first decomposition preserved
