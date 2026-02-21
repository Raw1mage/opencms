# Event: Update miatdiagram hierarchy and ModuleRef rules

Date: 2026-02-21
Status: Done

## User requirement

- IDEF0 numbering hierarchy is strict: `A0`, `A1..A9`, `A11..A19`, ...
- All hierarchy components can be further decomposed.
- Readability rule: keep direct child count per level under 10.
- GRAFCET must derive from IDEF0 hierarchy via module references.

## Changes

1. Updated skill working style (runtime/template) to include strict hierarchy convention.
2. Updated `idef0_normative_profile.md` with numbering and <=9 children rule.
3. Updated `idef0_grafcet_traceability_spec.md` to mark numbering and child-count constraints.
4. Updated `normalization_pipeline.md` gates for hierarchy validity and child-count checks.
5. Updated release checklist for hierarchy ID and direct-child-count gates.
6. Updated GRAFCET schema to require `ModuleRef` per step.

## Sync scope

- `.opencode/skills/miatdiagram/**`
- `templates/skills/miatdiagram/**`
