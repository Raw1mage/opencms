# IDEF0 Normative Profile (for miatdiagram)

This profile is a normalized engineering digest for portable skill execution.

## Scope

- Functional decomposition and interface semantics for IDEF0-style outputs.
- Compatible with drawmiat rendering expectations.

## Core concepts

- **Activity**: functional unit (`A0`, `A1`, `A11`...)
- **Hierarchy convention**:
  - Root: `A0`
  - Level-1: `A1..A9`
  - Children of `A1`: `A11..A19`
  - Children of `A11`: `A111..A119`
  - And so on
- **ICOM arrows**:
  - Input -> left
  - Control -> top
  - Output -> right
  - Mechanism -> bottom

## Minimum compliant requirements (MUST)

1. Every activity has unique hierarchical ID.
2. Every activity has a clear verb-oriented title.
3. Every major function exposes ICOM interfaces when applicable.
4. Arrow direction and semantic type must be consistent.
5. Parent-child decomposition keeps intent traceability.
6. External interfaces must be explicit (`EXTERNAL` endpoints).
7. Each decomposition level must keep child count under 10 (`<=9`) for readability.

## Recommended requirements (SHOULD)

1. Keep A0 concise and goal-centered.
2. Keep L1 limited to MVP-priority functions first.
3. Keep naming deterministic and domain-consistent.
4. Split overloaded activities into child decomposition.

## Common anti-patterns

- Function titles as nouns only (no actionable verb).
- Mixing control and input semantics.
- Decomposition levels without parent traceability.
- Arrows without labels or unclear intent.
- A parent activity containing 10+ direct children.
