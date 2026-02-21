# Skill: miatdiagram

中文常稱：**miat方法論 / 方法論**；口語：**miat skill**。

## Overview

Convert plain-language requirements into drawmiat-ready JSON for:

- IDEF0 (function + ICOM decomposition)
- GRAFCET (step-transition behavior model)

IDEF0 and GRAFCET must stay traceable: GRAFCET module/state-machine blocks are derived from IDEF0 module hierarchy.

Generated JSON should follow drawmiat canonical template structures (IDEF0 template + GRAFCET example format), with compatibility-first field naming.

This package is **portable and self-contained**: required references, templates, schemas, and checklists are bundled under `references/`.

## Use this skill when

- User asks for requirement decomposition, process diagrams, state-machine diagrams, or MVP-first module planning.
- Output needs to be directly renderable by drawmiat.

## Working style

- Respect user wording and priorities.
- Prefer MVP-first layered planning.
- When critical info is missing, propose options and ask with `mcp_question`.
- Keep output practical and execution-oriented (not just conceptual).
- Keep hierarchy readable: IDEF0 IDs follow `A0 -> A1..A9 -> A11..A19 ...`, and each parent should stay under 10 children.
- Clarification questions are dynamically planned with default upper bound 12; adjust with user when practical scope requires.
- If drawmiat implementation status conflicts with ideal spec, choose practical interoperability and document trade-offs in `validation_notes`.

## Output files

Write normalized files to user-selected directory (default `<repo>/docs/`):

- Root level naming (required):
  - `<repo>_a0_idef0.json`
  - `<repo>_a0_grafcet.json`
- Decomposed levels follow same convention:
  - `<repo>_a1_idef0.json`, `<repo>_a1_grafcet.json`
  - `<repo>_a2_idef0.json`, `<repo>_a2_grafcet.json`
  - `<repo>_a11_idef0.json`, `<repo>_a11_grafcet.json`
  - ...

Minimum decomposition baseline: must output at least `a0`, `a1`, `a2`; deeper levels are decided through AI-user interaction.

## Output payload

Return:

1. `analysis_summary`
2. `mvp_priority_order`
3. `idef0_descriptor`
4. `grafcet_descriptor`
5. `assumptions`
6. `validation_notes`
7. `written_files`
8. `decision_trace`

## Bundled reference index

- `references/idef0_normative_profile.md`
- `references/grafcet_normative_profile.md`
- `references/normalization_pipeline.md`
- `references/idef0_grafcet_traceability_spec.md`
- `references/drawmiat_format_profile.md`
- `references/schemas/idef0.schema.json`
- `references/schemas/grafcet.schema.json`
- `references/templates/idef0.context.template.json`
- `references/templates/grafcet.mvp.template.json`
- `references/checklists/release_gate.md`
