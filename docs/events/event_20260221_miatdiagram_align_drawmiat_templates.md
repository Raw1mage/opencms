# Event: Align miatdiagram output format with drawmiat templates

Date: 2026-02-21
Status: Done

## Context

User requested that miatdiagram output format should follow drawmiat template JSON shapes.

## Source references used

- `/home/pkcs12/projects/drawmiat/webapp/idef0/template.json`
- `/home/pkcs12/projects/drawmiat/Example/Grafcet.json`

## Changes

1. Added `drawmiat_format_profile.md` in runtime/template skill bundles.
2. Updated `SKILL.md` (runtime/template) to explicitly follow drawmiat canonical structures.
3. Updated GRAFCET schema (runtime/template):
   - required canonical keys now include:
     - `LinkInputType`
     - `LinkInputNumber`
     - `SubGrafcet`
   - retained optional `ModuleRef` for IDEF0 traceability extension.
4. Updated GRAFCET MVP template (runtime/template) to include canonical drawmiat fields.

## Result

miatdiagram now targets drawmiat-compatible canonical JSON while preserving strict IDEF0->GRAFCET traceability metadata capability.
