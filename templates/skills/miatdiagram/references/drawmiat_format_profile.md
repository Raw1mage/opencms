# drawmiat Format Profile (Canonical JSON Shapes)

This note captures canonical output field sets used by drawmiat templates/examples.

## IDEF0 canonical shape

Top-level keys:

- `diagram_title` (string)
- `node_reference` (string, e.g. `A0`)
- `activities` (array)
- `arrows` (array)

Activity object keys:

- `id` (required)
- `title` (required)
- `description` (optional)
- `decomposition` (optional, nested diagram)

Arrow object keys:

- `id` (required)
- `label` (required)
- `source` (required)
- `target` (required)
- `description` (optional)
- `type` (optional extension)

## GRAFCET canonical shape

File root is an array of Step objects.

Step object canonical keys (from drawmiat examples):

- `StepNumber`
- `StepType`
- `StepAction`
- `LinkInputType`
- `LinkOutputType`
- `LinkInputNumber`
- `LinkOutputNumber`
- `Condition`
- `SubGrafcet`

Optional extension key for traceability:

- `ModuleRef` (IDEF0 module ID, e.g. `A1`)

Compatibility policy:

1. Canonical drawmiat keys should always be present.
2. Extensions must not break renderer compatibility.
3. Keep additional keys minimal and documented.
4. If spec vs implementation conflict appears, prefer practical runnable JSON and record deviation note.

## Validation responsibility boundary

- Schema + semantic checks in this skill are preflight quality gates.
- Compile/strict parse validation should be provided by drawmiat-side API/tooling when available.
