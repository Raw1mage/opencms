# Event: Update miatdiagram naming/scope/question/validation rules

Date: 2026-02-21
Status: Done

## User directives applied

1. Output naming convention:
   - `<repo>_a0_idef0.json`, `<repo>_a0_grafcet.json`
   - deeper levels follow `<repo>_aX_idef0.json` / `<repo>_aX_grafcet.json`
2. Minimum decomposition baseline:
   - must include `a0`, `a1`, `a2`
   - deeper decomposition decided through AI-user interaction
3. Clarification questions:
   - dynamic planning
   - default upper bound 12, adjustable by interaction/need
4. drawmiat conflict handling:
   - practical interoperability first, deviations documented
5. Validation boundary:
   - skill provides preflight schema/semantic checks
   - compile/strict parse validation delegated to drawmiat API/tooling when available

## Files updated

- `.opencode/skills/miatdiagram/SKILL.md`
- `.opencode/skills/miatdiagram/references/{normalization_pipeline.md,release_gate.md,drawmiat_format_profile.md,idef0_grafcet_traceability_spec.md}`
- `templates/skills/miatdiagram/SKILL.md`
- `templates/skills/miatdiagram/references/{normalization_pipeline.md,release_gate.md,drawmiat_format_profile.md,idef0_grafcet_traceability_spec.md}`
