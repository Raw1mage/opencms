# Event: Build portable miatdiagram skill package

Date: 2026-02-21
Status: Done

## Objective

Make `miatdiagram` self-sufficient and portable, without mandatory runtime dependency on external `~/projects/drawmiat` docs.

## Work completed

1. Refactored `miatdiagram` skill description to a flexible, high-level execution guide.
2. Added bundled reference package under both runtime/template paths:
   - Normative profiles for IDEF0 and GRAFCET
   - Requirement normalization pipeline
   - JSON schemas (IDEF0/GRAFCET)
   - Starter templates
   - Release gate checklist
3. Kept output contract focused on practical delivery (`*_idef0.json`, `*_grafcet.json`, decision trace).

## Paths

- Runtime: `.opencode/skills/miatdiagram/**`
- Template: `templates/skills/miatdiagram/**`

## Notes

- External drawmiat repository is now optional reference, not a hard requirement.
- Skill package can operate from its own bundled references.
