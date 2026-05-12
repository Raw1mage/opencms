# Invariants

## Invariants

Cross-cut guarantees that must hold regardless of code-generation language or implementation choice.

- **INV-1 Example invariant** — description of the guarantee
  - **Scope**: which parts of the system this covers
  - **Why**: reason / dependent requirement

## Rationale

For each invariant above, explain why it is necessary and what breaks if it is violated.

## Enforcement Points

Where the invariant is asserted or verified — at API boundaries, in tests, via schema constraints, by runtime assertions, etc. Each invariant should map to at least one enforcement.

- INV-1 → enforced by: `<component or test>`
