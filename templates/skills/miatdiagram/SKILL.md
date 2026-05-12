---
name: miatdiagram
description: Convert requirements or existing repositories into drawmiat-ready IDEF0 and GRAFCET JSON with strict traceability. Use for requirement decomposition, reverse engineering, repo architecture extraction, process diagrams, state-machine diagrams, or MVP-first module planning.
---

# Skill: miatdiagram (MIAT System Architect & Diagram Generator)

中文常稱：**miat方法論 / 方法論**；口語：**miat skill**。

## 1. Overview

Convert plain-language requirements **or reverse-engineer an existing repository** into drawmiat-ready JSON descriptors.
Apply the **MIAT (Machine Intelligence and Automation Technology) methodology** which separates system design into static spatial structure and dynamic temporal behavior:

- **IDEF0 (Functional Architecture)**: defines module hierarchy, functional decomposition, and ICOM (Input, Control, Output, Mechanism) interfaces.
- **GRAFCET (Discrete Event Behavior Model)**: defines dynamic control flow, state transitions, and parallel logic on the time axis.

The two models must maintain strict **traceability**: GRAFCET module and state-machine scopes must directly inherit from the IDEF0 module hierarchy.

Generated JSON follows drawmiat canonical template structures with compatibility-first field naming.

This skill now supports **two entry modes**:

1. **Forward Design Mode** — start from requirements / ideas / desired workflows.
2. **Repo Reverse Engineering Mode** — start from a local repo or GitHub repo, extract architecture evidence, then normalize it into IDEF0 + GRAFCET artifacts.

This package is **portable and self-contained**: required references, templates, schemas, and checklists are bundled under `references/`.

## 2. Use this skill when

- User asks for requirement decomposition, process diagrams, state-machine diagrams, or MVP-first module planning.
- User asks to reverse engineer an existing repo, infer architecture from source code, or convert a GitHub codebase into architecture diagrams.
- User asks for repo/module decomposition, subsystem boundaries, runtime flow extraction, or state/control-flow extraction from an existing implementation.
- Output needs to be directly renderable by drawmiat.

## 3. Working style

- Respect user wording and priorities.
- Prefer **MVP-first layered planning**.
- When critical info is missing, propose options and ask with `mcp_question` (default clarification loop upper bound: 12 questions; adjust with user approval).
- Keep output practical and execution-oriented (not just conceptual).
- Keep hierarchy readable: strict IDEF0 numbering convention (`A0 -> A1..A9 -> A11..A19`), each parent **at most 9 children**.
- If drawmiat implementation status conflicts with ideal spec, choose practical interoperability and document trade-offs in `validation_notes`.
- In reverse-engineering tasks, use **evidence-first decomposition**: docs -> structure -> boundaries -> flows -> state logic -> normalization.
- Never invent hidden modules or fallback flows; if evidence is insufficient, record uncertainty in `assumptions` / `validation_notes` and ask for clarification.

## 4. Repo Reverse Engineering Mode

Use this mode when the user wants to derive diagrams from an existing codebase rather than from greenfield requirements.

### Objective

Transform repo evidence into:

- **IDEF0**: functional/module hierarchy, interfaces, inputs/controls/outputs/mechanisms
- **GRAFCET**: runtime state progression, discrete control transitions, branch / sync logic

### Required evidence order

1. **Framework docs first**
   - Read repo architecture/spec/event docs before rebuilding the mental model from source.
2. **Structural inventory**
   - Identify top-level packages, apps, services, runtime entrypoints, and integration boundaries.
3. **Boundary mapping**
   - Determine user-facing boundaries, API boundaries, persistence boundaries, provider/infrastructure boundaries.
4. **Control/data-flow tracing**
   - Trace request flow, event flow, orchestration flow, and persistence flow.
5. **State / lifecycle extraction**
   - Identify lifecycle transitions, state machines, worker loops, or branch/join behavior suitable for GRAFCET.
6. **Normalization to MIAT hierarchy**
   - Collapse noisy implementation detail into a readable IDEF0 hierarchy while preserving causal traceability.

### Reverse-engineering workflow

1. **Scope lock**
   - Confirm target repo/path, desired depth, and target subsystem(s).
2. **SSOT read pass**
   - Read architecture/spec/event docs and any existing design notes.
3. **Code evidence pass**
   - Search before read; identify entrypoints, module boundaries, orchestrators, and stateful components.
4. **Candidate module slicing**
   - Draft A0/L1 modules from observed responsibilities, not folder names alone.
5. **ICOM extraction**
   - For each candidate module, extract Inputs / Controls / Outputs / Mechanisms from actual code paths.
6. **Behavior extraction**
   - Convert lifecycle/event/control transitions into GRAFCET step/transition candidates.
7. **Traceability check**
   - Ensure every GRAFCET scope maps to an IDEF0 module.
8. **Output write**
   - Write normalized JSON, assumptions, validation notes, and evidence trace.

### Reverse-engineering heuristics

- Prefer **responsibility boundaries** over raw directory boundaries.
- Prefer **runtime orchestration paths** over static type trees.
- Treat routers/controllers/commands as potential control boundaries, not always leaf modules.
- Treat queues/events/SSE/websocket/pubsub as transition evidence for GRAFCET.
- Treat config/env/policies/feature flags as **Control** arrows in IDEF0.
- Treat SDKs, databases, CLIs, workers, external services, and operators as **Mechanism** arrows unless the repo clearly models them as transformed business inputs.

### Reverse-engineering stop conditions

Pause and ask when any of the following blocks correctness:

- target scope is ambiguous
- multiple architecture interpretations are equally plausible
- critical runtime path is missing from available files
- user must choose between subsystem-only vs whole-repo decomposition

### Minimum output for repo reverse engineering

In addition to normal outputs, include:

1. `source_inventory`
2. `boundary_map`
3. `evidence_trace`
4. `traceability_matrix`
5. `confidence_notes`

## 5. IDEF0 Normative Profile

IDEF0 structurally describes system functions and data flow.

### Activity (functional block)

- Represents a function or activity; name MUST be an active **verb phrase in Title Case**.
- No generic words ("function", "activity", "process", "module", "system").
- No abbreviations, prepositions, conjunctions, or articles.
- Each title must be unique across the entire model.

### Hierarchy convention

IDEF0 decomposition is **recursive and unlimited in depth**. Any activity can be decomposed into 2-9 child activities, and each child can be further decomposed the same way.

| Level          | IDs                | Example                   | Decomposition of |
| -------------- | ------------------ | ------------------------- | ---------------- |
| Root / context | `A0`               | Single top-level activity | —                |
| Level 1        | `A1`..`A9`         | 2-9 children of A0        | A0               |
| Level 2        | `A11`..`A19`       | Children of A1            | A1               |
| Level 3        | `A111`..`A119`     | Children of A11           | A11              |
| Level N        | `A1...1`..`A1...9` | Children of parent        | Parent activity  |

**Key rules**:

- Each parent activity has **at most 9** direct children (digit 1-9 appended).
- ID encodes full ancestry: `A312` = child 2 of A31, which is child 1 of A3, which is child of A0.
- Decomposition depth is **not limited** — go as deep as the system requires.
- When an activity is decomposed, set `"decomposition": "<child_node_reference>"` (e.g. `"decomposition": "A1"`) in the parent's JSON. Leave `null` for leaf activities.
- Each decomposition level produces its own pair of files: `<repo>_a1_idef0.json` describes A1's children (A11..A19), `<repo>_a11_idef0.json` describes A11's children (A111..A119), etc.
- Parent-child boundary arrows must map consistently: every Input/Control/Output/Mechanism arrow entering or leaving the parent must appear as a boundary arrow in the child diagram.

### ICOM arrow rules

| Type              | Entry side | Semantics                                                           |
| ----------------- | ---------- | ------------------------------------------------------------------- |
| **Input (I)**     | Left       | Data or material transformed/consumed by the activity               |
| **Control (C)**   | Top        | Conditions, constraints, policies governing execution               |
| **Output (O)**    | Right      | Results produced by the activity                                    |
| **Mechanism (M)** | Bottom     | Hardware, software, personnel, or resources performing the activity |

- Every activity MUST have at least one **Input** arrow AND at least one **Output** arrow. An activity with no input has nothing to transform; an activity with no output produces nothing.
- Control and Mechanism arrows are recommended but not mandatory.
- Parent-child boundary arrows must map consistently during decomposition.

## 6. GRAFCET Normative Profile

GRAFCET (IEC 60848) describes discrete-event behavior with emphasis on parallel processing and synchronization.

### Strict alternation rule

Steps (states) and Transitions must alternate strictly. No Step-to-Step or Transition-to-Transition direct connections.

### Core elements

| Field        | Values                             | Description                                                                                       |
| ------------ | ---------------------------------- | ------------------------------------------------------------------------------------------------- |
| `StepType`   | `initial`, `normal`, `sub_grafcet` | Step classification                                                                               |
| `StepAction` | string                             | Stable behavior executed when step is active                                                      |
| `Condition`  | string array                       | Transition guard — must be explicit, evaluable boolean conditions (events, timers, sensor values) |

### Structure logic (LinkOutputType)

| Type                                 | Semantics                                |
| ------------------------------------ | ---------------------------------------- |
| `track`                              | Single sequential segment                |
| `divergence_or` / `convergence_or`   | Conditional branch / selection (If-Else) |
| `divergence_and` / `convergence_and` | Parallel fork / synchronization join     |

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

## 7. IDEF0-GRAFCET Traceability

- **Mapping**: Every GRAFCET module MUST correspond to one IDEF0 module (e.g. A1, A11).
- **Key field**: Every GRAFCET Step object MUST include `ModuleRef` referencing its IDEF0 module ID.
- **No orphans**: A GRAFCET module without a valid IDEF0 reference is invalid. SubGrafcet nesting must not violate IDEF0 parent-child structure.
- **Parent chain**: If GRAFCET module `A11` exists, its parent chain (`A1` → `A11`) must exist in the IDEF0 hierarchy.
- **Evidence chain**: In reverse-engineering mode, every top-level IDEF0 activity and every GRAFCET module SHOULD be explainable from repo evidence (file, component, route, event, lifecycle, or runtime contract).

## 8. Output files & JSON format

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
  "activities": [{ "id": "A1", "title": "String", "description": "Optional", "decomposition": null }],
  "arrows": [{ "id": "AR1", "source": "EXTERNAL", "target": "A1:input", "label": "String", "type": "input" }]
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

## 9. Release gate checklist

Before delivering final JSON, the internal normalization pipeline must pass:

1. JSON format valid; all required fields present (including `analysis_summary`, `idef0_descriptor`, `grafcet_descriptor`, `decision_trace`).
2. IDEF0-GRAFCET traceability complete: no orphan GRAFCET modules, all `ModuleRef` values valid.
3. Numbering convention correct: IDEF0 nodes follow `A0`, `A1`.. rules; each parent has at most 9 children.
4. Minimum decomposition baseline exists (`a0`, `a1`, `a2` artifacts).
5. Semantically correct: GRAFCET transition conditions explicit, no undefined switch targets.
6. `decision_trace` and `assumptions` included in output payload.
7. Reverse-engineering mode must include evidence-backed `source_inventory`, `boundary_map`, and `traceability_matrix`.

## 10. Output payload

Return:

1. `analysis_summary`
2. `mvp_priority_order`
3. `idef0_descriptor`
4. `grafcet_descriptor`
5. `assumptions`
6. `validation_notes`
7. `written_files`
8. `decision_trace`
9. `source_inventory` (required for reverse-engineering mode)
10. `boundary_map` (required for reverse-engineering mode)
11. `evidence_trace` (required for reverse-engineering mode)
12. `traceability_matrix` (required for reverse-engineering mode)
13. `confidence_notes` (required for reverse-engineering mode)

## 11. drawmiat Rendering Service

Generated JSON MUST be rendered into SVG diagrams. The rendering service is provided by **drawmiat**, which exposes both a web UI and an MCP server.

### Rendering via MCP (preferred)

When this skill generates IDEF0 or GRAFCET JSON, you SHOULD immediately render it by calling the drawmiat MCP tools. This provides instant visual feedback to the user.

**Available MCP tools:**

| Tool | Purpose |
|------|---------|
| `validate_diagram` | Validate JSON structure before rendering |
| `generate_diagram` | Render JSON into SVG diagram(s) |

**Workflow:**
1. Generate JSON following the schemas in this skill
2. Call `validate_diagram(diagram_type, json_payload)` to check for errors
3. Fix any reported issues
4. Call `generate_diagram(diagram_type, json_payload, output_dir)` to produce SVG

### MCP connection setup

If drawmiat MCP is not already connected, proactively help the user set it up:

**Remote SSE (recommended for most users):**
```json
{
  "drawmiat": {
    "type": "remote",
    "url": "https://miat.thesmart.cc/mcp/sse",
    "enabled": true
  }
}
```

**Local stdio (for users who have drawmiat installed locally):**
```json
{
  "drawmiat": {
    "type": "local",
    "command": ["python3", "-u", "/path/to/drawmiat/mcp_server.py"],
    "enabled": true
  }
}
```

### Web UI fallback

If MCP is not available, instruct the user to paste the generated JSON at:
- **https://miat.thesmart.cc** — auto-detects IDEF0 (object) vs Grafcet (array) and renders SVG

### Source code

- Repository: https://github.com/Raw1mage/drawmiat
- Documentation: https://miat.thesmart.cc/docs/mcp

## Bundled reference index

- `references/idef0_normative_profile.md`
- `references/grafcet_normative_profile.md`
- `references/normalization_pipeline.md`
- `references/repo_reverse_engineering_pipeline.md`
- `references/idef0_grafcet_traceability_spec.md`
- `references/drawmiat_format_profile.md`
- `references/schemas/idef0.schema.json`
- `references/schemas/grafcet.schema.json`
- `references/templates/idef0.context.template.json`
- `references/templates/grafcet.mvp.template.json`
- `references/checklists/release_gate.md`
