# IDEF0 Normative Profile (for miatdiagram)

This profile is a normalized engineering digest for portable skill execution, based on IEEE 1320.1 conventions.

## Scope

- Functional decomposition and interface semantics for IDEF0-style outputs.
- Compatible with drawmiat rendering expectations.

## Core concepts

- **Activity**: functional unit (`A0`, `A1`, `A11`...)
- **Hierarchy convention** (recursive, unlimited depth):
  - Root: `A0`
  - Level-1: `A1..A9` (children of A0)
  - Level-2: `A11..A19` (children of A1), `A21..A29` (children of A2), etc.
  - Level-3: `A111..A119` (children of A11), etc.
  - Level-N: append digit 1-9 to parent ID
  - **No depth limit** — decompose as many levels as the system requires
  - ID encodes full ancestry: `A312` = child 2 of A31, child 1 of A3, child of A0
  - Each parent produces at most 9 children
- **ICOM arrows**:
  - Input (I) -> left: data or material transformed/consumed by the activity
  - Control (C) -> top: conditions, constraints, policies governing execution
  - Output (O) -> right: results produced by the activity
  - Mechanism (M) -> bottom: hardware, software, personnel, or resources performing the activity

## Activity naming rules (IEEE 1320.1)

1. Name MUST be an active verb phrase in Title Case (e.g. "Process Sensor Data").
2. No generic filler words: "function", "activity", "process", "module", "system".
3. No abbreviations, prepositions, conjunctions, or articles.
4. Each activity title must be unique across the entire model.

## Minimum compliant requirements (MUST)

1. Every activity has unique hierarchical ID.
2. Every activity has a clear verb-oriented title following naming rules above.
3. Every activity MUST have at least one Input arrow AND at least one Output arrow. An activity with no input has nothing to transform; an activity with no output produces nothing — both violate functional decomposition semantics and cause renderer routing anomalies.
4. Control and Mechanism arrows are recommended but not mandatory.
5. Arrow direction and semantic type must be consistent.
6. Parent-child decomposition keeps intent traceability.
7. Parent-child boundary consistency: parent boundary arrows must map to child boundary arrows.
8. External interfaces must be explicit (`EXTERNAL` endpoints).
9. Each decomposition level must keep child count under 10 (`<=9`) for readability.

## Recommended requirements (SHOULD)

1. Keep A0 concise and goal-centered.
2. Keep L1 limited to MVP-priority functions first.
3. Keep naming deterministic and domain-consistent.
4. Split overloaded activities into child decomposition.

## Common anti-patterns

- Function titles as nouns only (no actionable verb).
- Generic words in titles ("Process Module", "System Function").
- Mixing control and input semantics.
- Missing Input or Output arrows on an activity (hard requirement).
- Decomposition levels without parent traceability.
- Arrows without labels or unclear intent.
- A parent activity containing 10+ direct children.
