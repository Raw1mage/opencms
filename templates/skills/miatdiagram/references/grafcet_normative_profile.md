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
