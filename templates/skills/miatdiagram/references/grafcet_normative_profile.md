# GRAFCET Normative Profile (for miatdiagram)

This profile is a practical normalization of IEC 60848-style modeling for portable skill execution.

## Scope

- Sequential control logic modeling with steps, transitions, and branching.
- JSON structure aligned with drawmiat mapping.

## Core concepts

- **StepNumber**: unique step ID
- **StepType**: `initial` | `normal` | `sub_grafcet`
- **StepAction**: action executed when step active
- **ModuleRef**: source IDEF0 module ID (`A*`) this step belongs to
- **LinkOutputNumber**: next step IDs
- **LinkOutputType**: `track` | `divergence_or` | `divergence_and` | `convergence_and`
- **Condition**: transition guard condition list
- **Gates[]**: explicit divergence/convergence gate definitions required for every fan-out/fan-in in strict design.
- **Edges[]**: explicit connection list; every edge must have `EdgeId = From + To` using standard port codes such as `S1O1G1I1` or `G1O1S2I1`.

## Strict alternation rule

Steps (states) and Transitions must alternate strictly. No Step-to-Step or Transition-to-Transition direct connections.

## Evolution rules (IEC 60848)

1. **Alternation**: Steps and Transitions must alternate strictly.
2. **Minimum model**: At least 2 Steps + 1 Transition. Exactly one Initial Step per independent graph.
3. **Step semantics**: Each Step = stable behavior. Actions execute only when Step is active.
4. **Transition semantics**: Every Transition must have an explicit, evaluable boolean condition.
5. **Transition firing**: ALL preceding Steps must be active AND condition must be True.
6. **Synchronous evolution**: Firing simultaneously deactivates all preceding Steps and activates all succeeding Steps.
7. **Simultaneous clearing**: Multiple armed+triggered Transitions fire simultaneously.
8. **Activation priority**: If a Step is simultaneously activated and deactivated, activation wins.

## Structure logic (LinkOutputType)

| Type | Semantics |
|------|-----------|
| `track` | Single sequential segment |
| `divergence_or` / `convergence_or` | Conditional branch / selection (If-Else) |
| `divergence_and` / `convergence_and` | Parallel fork / synchronization join |

## Minimum compliant requirements (MUST)

1. Exactly one initial step per independent graph unless explicitly modularized.
2. Step IDs are unique and referenced targets must exist.
3. Every transition branch has explicit condition(s).
4. AND/OR divergence semantics are explicit in `LinkOutputType`.
5. Synchronization logic is explicit when converging parallel branches.
6. Complex nested control should use `SubGrafcet`.
7. Every step has `ModuleRef`, and `ModuleRef` must exist in IDEF0 hierarchy.
8. Every multi-output source must define an explicit divergence gate in `Gates[]`; the AI must choose `divergence_or` vs `divergence_and` from workflow semantics.
9. Every multi-input target must define an explicit convergence gate in `Gates[]`; the AI must choose `convergence_or` vs `convergence_and` from workflow semantics.
10. Every gate must have stable `GateNumber` / `GateId`, `Inputs[]`, and `Outputs[]`; every connection must be represented in `Edges[]`.

## Validator-only repair loop

The drawmiat MCP validator is the hard-coded compliance checker. It reports structural violations and repair targets, but it must not rewrite JSON or infer OR/AND semantics.

Use this loop for every GRAFCET artifact:

1. Draft or edit candidate JSON.
2. Call `validate_grafcet_json(json_payload)` from the miatdiagram workflow, implemented by drawmiat MCP `validate_diagram` with `diagram_type="grafcet"` and `validation_profile="strict_design"`.
3. The AI updates the source JSON according to diagnostics: add missing `Gates[]`, add missing `Edges[]`, correct `EdgeId`, correct port references, or choose explicit gate semantics.
4. Repeat validation until `ok=true`.
5. Render only after validation passes.

The validator may suggest where a gate or edge is required, but the AI is responsible for redesigning JSON semantics. Do not use an auto-canonicalizer as a substitute for design.

## Recommended requirements (SHOULD)

1. Keep main flow readable and short for MVP.
2. Isolate error/recovery logic into dedicated branches.
3. Avoid implicit assumptions in branch guards.
4. Keep action names deterministic and testable.

## Common anti-patterns

- Missing conditions in multi-branch transitions.
- Using OR where synchronization requires AND.
- Broken loops with no path back to stable states.
- Reusing step IDs across nested graphs.
- Missing `ModuleRef` or mapping to unknown IDEF0 module.
