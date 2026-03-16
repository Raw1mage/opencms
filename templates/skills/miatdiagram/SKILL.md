---
name: miatdiagram
description: Convert plain-language requirements into drawmiat-ready JSON for IDEF0 and GRAFCET with traceable module hierarchy and compatibility-first field naming. Use when users ask for requirement decomposition, process diagrams, state-machine diagrams, or MVP-first module planning.
---

# Skill: miatdiagram (MIAT System Architect & Diagram Generator)

中文常稱：**miat方法論 / 方法論**；口語：**miat skill**。

## 1. Overview

Convert plain-language requirements into drawmiat-ready JSON descriptors.
Apply the **MIAT (Machine Intelligence and Automation Technology) methodology** which separates system design into static spatial structure and dynamic temporal behavior:

- **IDEF0 (Functional Architecture)**: defines module hierarchy, functional decomposition, and ICOM (Input, Control, Output, Mechanism) interfaces.
- **GRAFCET (Discrete Event Behavior Model)**: defines dynamic control flow, state transitions, and parallel logic on the time axis.

The two models must maintain strict **traceability**: GRAFCET module and state-machine scopes must directly inherit from the IDEF0 module hierarchy.

Generated JSON follows drawmiat canonical template structures with compatibility-first field naming.

This package is **portable and self-contained**: required references, templates, schemas, and checklists are bundled under `references/`.

## 2. Use this skill when

- User asks for requirement decomposition, process diagrams, state-machine diagrams, or MVP-first module planning.
- Output needs to be directly renderable by drawmiat.

## 3. Working style

- Respect user wording and priorities.
- Prefer **MVP-first layered planning**.
- When critical info is missing, propose options and ask with `mcp_question` (default clarification loop upper bound: 12 questions; adjust with user approval).
- Keep output practical and execution-oriented (not just conceptual).
- Keep hierarchy readable: strict IDEF0 numbering convention (`A0 -> A1..A9 -> A11..A19`), each parent **at most 9 children**.
- If drawmiat implementation status conflicts with ideal spec, choose practical interoperability and document trade-offs in `validation_notes`.

## 4. IDEF0 Normative Profile

IDEF0 structurally describes system functions and data flow.

### Activity (functional block)

- Represents a function or activity; name MUST be an active **verb phrase in Title Case**.
- No generic words ("function", "activity", "process", "module", "system").
- No abbreviations, prepositions, conjunctions, or articles.
- Each title must be unique across the entire model.

### Hierarchy convention

IDEF0 decomposition is **recursive and unlimited in depth**. Any activity can be decomposed into 2-9 child activities, and each child can be further decomposed the same way.

| Level | IDs | Example | Decomposition of |
|-------|-----|---------|------------------|
| Root / context | `A0` | Single top-level activity | — |
| Level 1 | `A1`..`A9` | 2-9 children of A0 | A0 |
| Level 2 | `A11`..`A19` | Children of A1 | A1 |
| Level 3 | `A111`..`A119` | Children of A11 | A11 |
| Level N | `A1...1`..`A1...9` | Children of parent | Parent activity |

**Key rules**:
- Each parent activity has **at most 9** direct children (digit 1-9 appended).
- ID encodes full ancestry: `A312` = child 2 of A31, which is child 1 of A3, which is child of A0.
- Decomposition depth is **not limited** — go as deep as the system requires.
- When an activity is decomposed, set `"decomposition": "<child_node_reference>"` (e.g. `"decomposition": "A1"`) in the parent's JSON. Leave `null` for leaf activities.
- Each decomposition level produces its own pair of files: `<repo>_a1_idef0.json` describes A1's children (A11..A19), `<repo>_a11_idef0.json` describes A11's children (A111..A119), etc.
- Parent-child boundary arrows must map consistently: every Input/Control/Output/Mechanism arrow entering or leaving the parent must appear as a boundary arrow in the child diagram.

### ICOM arrow rules

| Type | Entry side | Semantics |
|------|-----------|-----------|
| **Input (I)** | Left | Data or material transformed/consumed by the activity |
| **Control (C)** | Top | Conditions, constraints, policies governing execution |
| **Output (O)** | Right | Results produced by the activity |
| **Mechanism (M)** | Bottom | Hardware, software, personnel, or resources performing the activity |

- Every activity MUST have at least one **Control** and one **Output** arrow.
- Input and Mechanism are optional but recommended.
- Parent-child boundary arrows must map consistently during decomposition.

## 5. GRAFCET Normative Profile

GRAFCET (IEC 60848) describes discrete-event behavior with emphasis on parallel processing and synchronization.

### Strict alternation rule

Steps (states) and Transitions must alternate strictly. No Step-to-Step or Transition-to-Transition direct connections.

### Core elements

| Field | Values | Description |
|-------|--------|-------------|
| `StepType` | `initial`, `normal`, `sub_grafcet` | Step classification |
| `StepAction` | string | Stable behavior executed when step is active |
| `Condition` | string array | Transition guard — must be explicit, evaluable boolean conditions (events, timers, sensor values) |

### Structure logic (LinkOutputType)

| Type | Semantics |
|------|-----------|
| `track` | Single sequential segment |
| `divergence_or` / `convergence_or` | Conditional branch / selection (If-Else) |
| `divergence_and` / `convergence_and` | Parallel fork / synchronization join |

### Evolution rules (IEC 60848)

1. **Alternation**: Steps and Transitions must alternate strictly.
2. **Minimum model**: At least 2 Steps + 1 Transition. Exactly one Initial Step per independent graph.
3. **Step semantics**: Each Step = stable behavior. Actions execute only when Step is active.
4. **Transition semantics**: Every Transition must have an explicit, evaluable boolean condition.
5. **Transition firing**: ALL preceding Steps must be active AND condition must be True.
6. **Synchronous evolution**: Firing simultaneously deactivates all preceding Steps and activates all succeeding Steps.
7. **Simultaneous clearing**: Multiple armed+triggered Transitions fire simultaneously.
8. **Activation priority**: If a Step is simultaneously activated and deactivated, activation wins.

### Uniqueness and validity

- Each independent graph must have at least 1 initial step (unless explicitly modularized).
- All branch conditions must be explicitly defined.

## 6. IDEF0-GRAFCET Traceability

- **Mapping**: Every GRAFCET module MUST correspond to one IDEF0 module (e.g. A1, A11).
- **Key field**: Every GRAFCET Step object MUST include `ModuleRef` referencing its IDEF0 module ID.
- **No orphans**: A GRAFCET module without a valid IDEF0 reference is invalid. SubGrafcet nesting must not violate IDEF0 parent-child structure.
- **Parent chain**: If GRAFCET module `A11` exists, its parent chain (`A1` → `A11`) must exist in the IDEF0 hierarchy.

## 7. Output files & JSON format

Write normalized files to user-selected directory (default `<repo>/docs/`).
Minimum decomposition baseline: must output at least `a0`, `a1`, `a2`.
Deeper decomposition: produce files for every level the system requires.

### File naming convention

- `<repo>_a0_idef0.json` / `<repo>_a0_grafcet.json` — A0 context diagram (shows A1..An)
- `<repo>_a1_idef0.json` / `<repo>_a1_grafcet.json` — A1 decomposition (shows A11..A1m)
- `<repo>_a11_idef0.json` / `<repo>_a11_grafcet.json` — A11 decomposition (shows A111..A11k)
- Pattern: `<repo>_a<id>_idef0.json` for any decomposed activity at any depth

### IDEF0 JSON structure

```json
{
  "diagram_title": "String",
  "node_reference": "A0",
  "activities": [
    { "id": "A1", "title": "String", "description": "Optional", "decomposition": null }
  ],
  "arrows": [
    { "id": "AR1", "source": "EXTERNAL", "target": "A1:input", "label": "String", "type": "input" }
  ]
}
```

Arrow `type`: `input` | `control` | `output` | `mechanism` | `call`

### GRAFCET JSON structure

Root is an array of Step objects:

```json
[
  {
    "StepNumber": 0,
    "ModuleRef": "A1",
    "StepType": "initial",
    "StepAction": "String",
    "LinkInputType": [],
    "LinkInputNumber": [],
    "LinkOutputNumber": [1],
    "LinkOutputType": "track",
    "Condition": ["start"],
    "SubGrafcet": []
  }
]
```

`ModuleRef` MUST point to an existing activity ID in the IDEF0 hierarchy.

## 8. Release gate checklist

Before delivering final JSON, the internal normalization pipeline must pass:

1. JSON format valid; all required fields present (including `analysis_summary`, `idef0_descriptor`, `grafcet_descriptor`, `decision_trace`).
2. IDEF0-GRAFCET traceability complete: no orphan GRAFCET modules, all `ModuleRef` values valid.
3. Numbering convention correct: IDEF0 nodes follow `A0`, `A1`.. rules; each parent has at most 9 children.
4. Minimum decomposition baseline exists (`a0`, `a1`, `a2` artifacts).
5. Semantically correct: GRAFCET transition conditions explicit, no undefined switch targets.
6. `decision_trace` and `assumptions` included in output payload.

## 9. Output payload

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
