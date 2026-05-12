# IDEF0 <-> GRAFCET Traceability Spec

## Purpose

Define strict correspondence between functional hierarchy (IDEF0) and behavioral hierarchy (GRAFCET).

## Hard mapping rules

1. Every GRAFCET module/state-machine scope MUST map to one IDEF0 module (`A*`).
2. Mapping direction is top-down:
   - IDEF0 A0/L1/L2 hierarchy defines allowed GRAFCET module scopes.
3. A GRAFCET module without IDEF0 reference is invalid.
4. A GRAFCET module may refine one IDEF0 module, but cannot cross parent boundaries.
5. Parent-child consistency:
   - If GRAFCET module `A11` exists, its parent chain (`A1` -> `A11`) must exist in IDEF0 hierarchy.
6. IDEF0 numbering convention is mandatory:
   - `A0` root, then `A1..A9`, then `A11..A19`, `A111..A119`...
7. Each IDEF0 parent module should have at most 9 direct children for readability.
8. Minimum decomposition baseline requires `A0`, `A1`, `A2` modules and their corresponding GRAFCET coverage.

## Recommended descriptor linkage

- For each GRAFCET step object, include:
  - `ModuleRef`: IDEF0 module ID (example: `A1`, `A11`) (required in schema)
- Optional root-level mapping object:

```json
{
  "traceability": {
    "A1": [0, 1, 2],
    "A11": [10, 11]
  }
}
```

## Validation checks

1. All `ModuleRef` values exist in IDEF0 `activities.id` tree.
2. No step set references unknown module.
3. SubGrafcet nesting does not violate IDEF0 parent structure.
4. MVP L1 modules have corresponding top-level behavioral coverage.
5. Output artifact names follow `<repo>_aX_idef0.json` and `<repo>_aX_grafcet.json`.
