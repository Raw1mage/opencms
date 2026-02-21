# Skill: miatdiagram

中文常稱：**miat方法論 / 方法論**；口語：**miat skill**。

## Overview

Convert plain-language requirements into drawmiat-ready JSON for:

- IDEF0 (function + ICOM decomposition)
- GRAFCET (step-transition behavior model)

This package is **portable and self-contained**: required references, templates, schemas, and checklists are bundled under `references/`.

## Use this skill when

- User asks for requirement decomposition, process diagrams, state-machine diagrams, or MVP-first module planning.
- Output needs to be directly renderable by drawmiat.

## Working style

- Respect user wording and priorities.
- Prefer MVP-first layered planning.
- When critical info is missing, propose options and ask with `mcp_question`.
- Keep output practical and execution-oriented (not just conceptual).

## Output files

Write normalized files to user-selected directory (default `<repo>/docs/`):

- `<name>_idef0.json`
- `<name>_grafcet.json`

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
- `references/schemas/idef0.schema.json`
- `references/schemas/grafcet.schema.json`
- `references/templates/idef0.context.template.json`
- `references/templates/grafcet.mvp.template.json`
- `references/checklists/release_gate.md`
