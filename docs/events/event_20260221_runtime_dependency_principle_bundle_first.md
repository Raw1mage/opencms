# Event: Runtime dependency principle (bundle-first, external-optional)

- **Date**: 2026-02-21
- **Status**: Done
- **Scope**: Architecture policy update only

## Decision

Adopted a normative runtime dependency principle for `cms`:

1. Runtime minimizes direct registry dependency.
2. Public LLM API connectivity is explicit exception.
3. Core runtime path follows **bundle-first**.
4. External packages are **optional extensions** and must not block baseline startup.

## Documentation Changes

- Updated `docs/ARCHITECTURE.md` with:
  - `## 17. Runtime Dependency Principle (Normative, cms)`
  - Ticket alignment updates (`TKT-001~004`) for bundle-first direction.

## Expected Impact

- Reduces startup fragility under registry/network instability.
- Makes runtime failure domain narrower (optional extension failure != core bootstrap failure).
