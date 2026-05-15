---
name: miatdiagram
description: Convert requirements or existing repositories into drawmiat-ready IDEF0 and GRAFCET JSON with strict traceability. Use for requirement decomposition, reverse engineering, repo architecture extraction, process diagrams, state-machine diagrams, or MVP-first module planning.
---

# Skill: miatdiagram (MIAT System Architect & Diagram Generator)

中文常稱：**miat方法論 / 方法論**；口語：**miat skill**。

## 1. Overview & first principles

Produce **spec-grade decomposition documents** for a target subsystem — forward (from requirements) or reverse (from existing code) — using the **MIAT (Machine Intelligence and Automation Technology) methodology**.

**Critical role positioning (2026-05-11 reframe)**:

- **IDEF0 is NOT global system architecture.** Each IDEF0 model describes the **workflow of one deliverable functional purpose** — Inputs / Controls / Outputs / Mechanisms for one A0 root activity and its recursive children. A repository that delivers N functional purposes needs N IDEF0 models (or a clearly partitioned namespace within one model). Do **not** flatten a multi-purpose system into a single IDEF0 root just because it's one repo.
- **System-level architecture is a separate first-class artifact.** It is rendered as a **module block diagram** (peer modules with arrows) or **stack diagram** (layered dependencies) — mermaid preferred, ASCII acceptable. This diagram answers "what are the parts and how do they layer", which is a different question from "what is the workflow of this one functional purpose".
- **GRAFCET (IEC 60848)** describes the runtime evolution of the workflow that IDEF0 decomposes. Steps reference IDEF0 activity ids; transitions describe events / conditions causing the workflow to advance.
- **Protocol datasheets** specify wire-level packet / message field shapes when the subsystem touches a handshake, protocol, or persisted file format. Datasheets are required for any wire-touching purpose.

The four artifacts (architecture, IDEF0, GRAFCET, protocol datasheet) are **load-bearing as a set**. Dropping one to "save time" loses the specific question that artifact answers:

| Artifact | Question it answers |
|---|---|
| Module architecture (block/stack) | What are the parts and how do they layer? |
| IDEF0 (per functional purpose) | What's the workflow that delivers this purpose? Inputs/Controls/Outputs/Mechanisms per step? |
| GRAFCET (per IDEF0 model) | How does the workflow evolve at runtime — sequence, branches, parallel, sync? |
| Protocol datasheet (per handshake) | What does each wire-level message look like field-by-field? |

Generated JSON for IDEF0 + GRAFCET follows drawmiat canonical template structures.

This skill supports **two entry modes as peers** (not one as the default and the other as a variant):

1. **Forward Design Mode** — start from requirements / ideas / desired workflows; produce all four artifact types for the proposed system.
2. **Reverse Engineering Mode** — start from a local repo or GitHub repo, extract evidence first, then produce the same four artifact types describing the existing system.

The **deliverable artifact set is identical** in both modes; only the input direction differs. Both modes must respect the IDEF0 role positioning above — i.e., a reverse-engineered codebase still needs a separate module architecture diagram on top of its IDEF0 models.

This package is **portable and self-contained**: required references, templates, schemas, and checklists are bundled under `references/`.

## 2. Use this skill when

- User asks for requirement decomposition, process diagrams, state-machine diagrams, or MVP-first module planning.
- User asks to reverse engineer an existing repo, infer architecture from source code, or convert a GitHub codebase into architecture diagrams.
- User asks for repo/module decomposition, subsystem boundaries, runtime flow extraction, or state/control-flow extraction from an existing implementation.
- User asks for a **protocol / handshake datasheet** — packet field tables, message-format specs, on-disk file format breakdown.
- User asks for a **system architecture overview** that should be paired with workflow decomposition (block + IDEF0 together).
- Output needs to be directly renderable by drawmiat (for IDEF0 / GRAFCET portions).

## 3. Working style

- Respect user wording and priorities.
- Prefer **MVP-first layered planning**.
- When critical info is missing, propose options and ask with `mcp_question` (default clarification loop upper bound: 12 questions; adjust with user approval).
- Keep output practical and execution-oriented (not just conceptual).
- Keep hierarchy readable: strict IDEF0 numbering convention (`A0 -> A1..A9 -> A11..A19`), each parent **at most 9 children**.
- If drawmiat implementation status conflicts with ideal spec, choose practical interoperability and document trade-offs in `validation_notes`.
- In reverse-engineering tasks, use **evidence-first decomposition**: docs -> structure -> boundaries -> flows -> state logic -> normalization.
- Never invent hidden modules or fallback flows; if evidence is insufficient, record uncertainty in `assumptions` / `validation_notes` and ask for clarification.
- **Do not conflate IDEF0 with system architecture.** When the target spans multiple deliverable functional purposes (e.g. "the whole codex-cli repo"), produce one module-architecture diagram covering the parts AND one IDEF0 model per functional purpose. A single A0 that tries to swallow everything is a smell — break it up.
- **Datasheet-grade rigor for wire surfaces.** Any handshake, protocol message, on-disk file format, or external-system contract earns a protocol datasheet with field-level columns. Hand-waving with prose where a table is expected is a delivery defect.

## 4. Deliverable artifact set (mandatory)

Every miat task — forward or reverse — produces this canonical artifact bundle for each in-scope subsystem / functional purpose. Missing artifacts are delivery defects.

### 4.1 Module architecture diagram (per subsystem)

- **Format**: mermaid block diagram or stack diagram (preferred — auto-renders in wiki / markdown viewers) OR ASCII block/stack art when mermaid is impractical. C4-style multi-zoom diagrams are NOT recommended as a default — they overlap heavily with the block+stack views below and add stakeholder-communication overhead that pure documentation / AI-reproduction workflows do not benefit from. Use C4 only when an explicit multi-stakeholder audience demands its vocabulary.
- **Content**: every box labelled with its actual path or module identifier (e.g. `codex-rs/core/src/client.rs::ModelClientSession` for code, `packages/opencode/src/session/llm.ts` for OpenCode, or business-domain module name for forward design).
- **Two complementary views recommended** when the subsystem has layering:
  - **Block view**: peers + arrows showing dependency / data direction.
  - **Stack view**: vertical layers showing what calls into what.
- **NOT the same as IDEF0.** This diagram answers "what are the parts and how do they relate"; IDEF0 answers "what is the workflow inside one part / functional purpose".
- **Why C4 is deprecated in this set**: the block diagram already covers C4's Component layer, the stack diagram already covers C4's Container layer, and the Module-architecture path labels (e.g. `crate/src/file.rs::Symbol`) already cover C4's Code layer. C4's only unique contribution is its Context-layer (external actors), which can ride as a single external-actor block on the same diagram. Keeping a separate c4.json artifact per chapter is redundant for AI-reproduction and reverse-engineering tasks; reserve C4 for cases where multiple stakeholder roles need a shared zoom-by-zoom vocabulary.

### 4.2 IDEF0 model (per deliverable functional purpose)

- One IDEF0 model per functional purpose. A repo / system that delivers multiple purposes produces multiple IDEF0 models, each with its own A0.
- Recursive decomposition rules (§6 below) unchanged.
- ICOM per activity unchanged.
- **Reminder**: an IDEF0 A0 root must name **one functional purpose**, not "the whole system". If you find yourself unable to write a single-clause active-verb title for A0, that's a sign you need to partition.

### 4.3 GRAFCET (per IDEF0 model)

- Pairs one-to-one with an IDEF0 model. Steps reference IDEF0 activity ids (`ModuleRef`).
- Rules from §7 below unchanged.
- An IDEF0 model without a GRAFCET is incomplete (you've described the structure but not the runtime evolution).

### 4.4 Protocol datasheet (when wire / handshake / file format is involved)

For every distinct message / packet / handshake / persisted file format the subsystem touches:

```
### <Message Name> (<direction>)

**Transport**: <HTTP METHOD path | WS frame opcode | SSE event name | on-disk file path | RPC method>
**Triggered by**: <event / call site / user action>
**Source**: <file:line where the writer/sender is implemented>

| Field | Type / Encoding | Required | Source (file:line) | Stability | Notes |
|---|---|---|---|---|---|
| `field_a` | UUID v4 string | required | `core/src/installation_id.rs:50` | stable-per-install | mirrors $CODEX_HOME/installation_id |

**Example payload** (sanitized — no real tokens / PII):
```json
{ "field_a": "00000000-0000-4000-8000-000000000000" }
```
```

Field columns explained:
- **Field**: exact name on the wire / in the file.
- **Type / Encoding**: e.g. "UUID v4 string", "uint64 LE", "JSON object", "newline-delimited UTF-8".
- **Required**: required vs optional. If conditional, name the condition.
- **Source (file:line)**: where the field is set or parsed in the codebase (reverse mode) or specified (forward mode).
- **Stability**: `stable-per-install` | `stable-per-session` | `stable-per-turn` | `per-turn` | `daily-flip` | `varies` — describes the cache / replay impact of the field's value changing.
- **Notes**: anything else worth flagging (anti-abuse signal, cache-key dimension, upstream-aligned vs OpenCode-only, etc.).

**Datasheets are mandatory** for subsystems that emit / consume wire bytes, handshakes, RPCs, or persisted file formats. Subsystems that don't touch any of those may replace the section with one line: `Protocol datasheet: N/A — this subsystem produces no wire-level messages; see <other-section> for downstream emission`.

### 4.5 Traceability matrix (mandatory for reverse mode, recommended for forward)

A table mapping every IDEF0 activity + GRAFCET step + datasheet field to the evidence that supports it. In reverse mode, evidence is `file:line` in the target repo. In forward mode, evidence is the requirement / decision id that introduced the artifact.

### 4.6 Open questions

Numbered list of claims that could not be verified (reverse mode) or specified (forward mode). Better to surface a gap than fabricate a citation or a spec line.

### 4.7 Cross-diagram traceability (load-bearing)

The four artifact types are **not independent** — they describe one system from different angles and MUST keep mutual references intact. Without these links, an architecture diagram drifts from its workflows, datasheets float without origin context, and the audit pass cannot prove the spec is internally consistent.

Required cross-links:

- **Module architecture → IDEF0 models**: every architecture box that delivers a functional purpose names the IDEF0 model (A0 id) that decomposes its workflow. Boxes that are pure infrastructure (a database, a 3rd-party service) need no IDEF0 link but must be reachable from at least one IDEF0 Mechanism cell.
- **IDEF0 Mechanisms → Module architecture**: every Mechanism cell in any A_N.M activity names the architecture box (or external mechanism) that performs the work. Mechanisms with no matching architecture box are a delivery defect — either the architecture is incomplete or the IDEF0 invented a phantom worker.
- **IDEF0 → GRAFCET**: every GRAFCET Step's `ModuleRef` references an existing A_N.M id in the paired IDEF0. (Already mandated in §8 IDEF0-GRAFCET Traceability — repeated here for completeness.)
- **GRAFCET → IDEF0**: the inverse is recommended but not enforced — an IDEF0 activity without any GRAFCET coverage is a hint that runtime semantics are missing, but legitimate for purely-structural activities.
- **Protocol datasheet → IDEF0 activity**: every datasheet's `Triggered by` field names the IDEF0 activity that emits or consumes the message. The datasheet's `Source (file:line)` field is the second leg of the link, pointing into Mechanism code.
- **Protocol datasheet → Module architecture**: implicit via the IDEF0 link, but the datasheet's transport (HTTP path / WS frame / file path) should be discoverable in the architecture box's I/O surface.
- **Across chapters (when batched like codex/cli-reversed-spec)**: forward references only to *audited* chapters; backward references freely. A chapter MUST NOT cite a not-yet-audited chapter's claim as load-bearing evidence.

The audit pass walks the cross-links explicitly: pick a random sample of IDEF0 Mechanism cells and verify each names a real architecture box; pick a random datasheet and verify it's reachable from an IDEF0 activity which is reachable from an architecture box.

## 5. Repo Reverse Engineering Mode

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

## 6. IDEF0 Normative Profile

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

## 7. GRAFCET Normative Profile

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

## 8. IDEF0-GRAFCET Traceability

- **Mapping**: Every GRAFCET module MUST correspond to one IDEF0 module (e.g. A1, A11).
- **Key field**: Every GRAFCET Step object MUST include `ModuleRef` referencing its IDEF0 module ID.
- **No orphans**: A GRAFCET module without a valid IDEF0 reference is invalid. SubGrafcet nesting must not violate IDEF0 parent-child structure.
- **Parent chain**: If GRAFCET module `A11` exists, its parent chain (`A1` → `A11`) must exist in the IDEF0 hierarchy.
- **Evidence chain**: In reverse-engineering mode, every top-level IDEF0 activity and every GRAFCET module SHOULD be explainable from repo evidence (file, component, route, event, lifecycle, or runtime contract).

## 9. Output files & JSON format

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

## 10. Release gate checklist

Before delivering final JSON, the internal normalization pipeline must pass:

1. **Module architecture diagram present** for each in-scope subsystem (§4.1). Block / stack / C4 form, mermaid preferred.
2. **One IDEF0 model per deliverable functional purpose** (§4.2). No single-IDEF0-for-whole-multi-purpose-system anti-pattern. A0 title is a single-clause active-verb phrase.
3. JSON format valid; all required fields present (including `analysis_summary`, `idef0_descriptor`, `grafcet_descriptor`, `decision_trace`).
4. IDEF0-GRAFCET traceability complete: no orphan GRAFCET modules, all `ModuleRef` values valid.
5. Numbering convention correct: IDEF0 nodes follow `A0`, `A1`.. rules; each parent has at most 9 children.
6. Minimum decomposition baseline exists (`a0`, `a1`, `a2` artifacts).
7. Semantically correct: GRAFCET transition conditions explicit, no undefined switch targets.
8. **Protocol datasheet present** for every wire / handshake / file-format touched by an in-scope subsystem (§4.4). Datasheet field columns complete (Field / Type / Required / Source / Stability / Notes) and example payload sanitized.
8a. **Cross-diagram traceability intact** (§4.7): every IDEF0 Mechanism resolves to an architecture box (or named external mechanism); every datasheet's `Triggered by` resolves to an IDEF0 activity; every architecture box that delivers a functional purpose names its IDEF0 A0 id.
9. `decision_trace`, `assumptions`, and **`open_questions`** included in output payload.
10. Reverse-engineering mode must include evidence-backed `source_inventory`, `boundary_map`, and `traceability_matrix`; forward-design mode must include traceability from each artifact to the requirement / decision id that introduced it.

## 11. Output payload

Return:

1. `analysis_summary`
2. `mvp_priority_order`
3. `module_architecture` — block / stack / C4 diagram(s), mermaid or ascii (§4.1, mandatory)
4. `idef0_descriptor` — one entry per deliverable functional purpose (§4.2)
5. `grafcet_descriptor` — paired with each idef0 entry (§4.3)
6. `protocol_datasheets` — array of datasheet entries (§4.4); empty array allowed for purely-internal subsystems with N/A explanation
7. `assumptions`
8. `validation_notes`
9. `open_questions` — numbered list of gaps not yet closed (§4.6, mandatory if any exist)
10. `written_files`
11. `decision_trace`
12. `source_inventory` (required for reverse-engineering mode)
13. `boundary_map` (required for reverse-engineering mode)
14. `evidence_trace` (required for reverse-engineering mode)
15. `traceability_matrix` (required in reverse-engineering mode; recommended in forward-design mode)
16. `confidence_notes` (required for reverse-engineering mode)

## 12. drawmiat Rendering Service

Generated JSON MUST be rendered into SVG diagrams. The rendering service is provided by **drawmiat**, which exposes both a web UI and an MCP server.

### Rendering via MCP (preferred)

When this skill generates IDEF0 or GRAFCET JSON, you SHOULD immediately render it by calling the drawmiat MCP tools. This provides instant visual feedback to the user.

**Available MCP tools:**

| Tool | Purpose |
|------|---------|
| `validate_diagram` | Hard-coded validator. Validate JSON structure and GRAFCET gate/edge compliance before rendering; returns diagnostics for the AI to use when editing JSON. |
| `generate_diagram` | Render JSON into SVG diagram(s) |

### GRAFCET validation function for AI JSON repair

Use this function contract whenever creating or updating GRAFCET JSON:

```text
validate_grafcet_json(json_payload):
  call drawmiat MCP validate_diagram with:
    diagram_type = "grafcet"
    validation_profile = "strict_design"
    json_payload = <candidate JSON string>
  return:
    ok: boolean
    errors: hard-coded validator diagnostics
    warnings: hard-coded validator warnings
    repair_targets: fields/objects the AI must edit in source JSON
```

Rules for the AI using this function:

- The validator is the authority for structural compliance; do not bypass it by reasoning from the SVG.
- The validator must **not** rewrite JSON and must **not** guess OR/AND semantics.
- If diagnostics mention missing explicit gate definitions, the AI must update the JSON by adding `Gates[]` and `Edges[]` explicitly.
- Every gate must have a stable `GateNumber` / `GateId` (`G1`, `G2`, ...), declared `GateType`, `Inputs[]`, and `Outputs[]`.
- Every edge must have `EdgeId = From + To`, e.g. `S1O1G1I1`, `G1O1S2I1`, `G1O2G2I1`.
- Condition/stub ownership belongs to the edge carrying the condition, usually a gate output edge for `divergence_*`.
- Repeat: edit JSON → call `validate_grafcet_json()` → fix diagnostics until `ok=true`; render only after validation passes.

**Workflow:**
1. Generate or update JSON following the schemas in this skill.
2. For GRAFCET, call `validate_grafcet_json(json_payload)`; for IDEF0/C4, call `validate_diagram(diagram_type, json_payload)`.
3. Fix reported diagnostics in the source JSON yourself; do not ask the renderer to auto-correct.
4. Re-run validation until it passes.
5. Call `generate_diagram(diagram_type, json_payload, output_dir)` to produce SVG.

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
