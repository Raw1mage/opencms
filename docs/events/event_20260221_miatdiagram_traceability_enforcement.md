# Event: Enforce IDEF0->GRAFCET traceability in miatdiagram skill

Date: 2026-02-21
Status: Done

## Context

User clarified a strict requirement: GRAFCET module state-machines must be derived from IDEF0 module hierarchy, with enforceable correspondence.

## Changes

1. Updated skill overview to state strict IDEF0/GRAFCET traceability.
2. Added bundled reference:
   - `references/idef0_grafcet_traceability_spec.md`
3. Updated normalization pipeline and release checklist to include hierarchy mapping gates.
4. Updated GRAFCET schema and template:
   - Added required `ModuleRef` (pattern `^A[0-9]+$`) per step.
5. Updated GRAFCET normative profile to include `ModuleRef` requirements and anti-pattern.

## Sync scope

- Runtime skill: `.opencode/skills/miatdiagram/**`
- Template skill: `templates/skills/miatdiagram/**`
