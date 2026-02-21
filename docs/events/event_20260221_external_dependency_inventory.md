# Event: External dependency inventory baseline

- **Date**: 2026-02-21
- **Status**: Done
- **Scope**: Architecture documentation (`docs/ARCHITECTURE.md`)

## Objective

Create a structured inventory of current external dependency surfaces before drafting decoupling proposals.

## What was documented

1. Three dependency planes:
   - Monorepo build/install plane
   - Runtime user-space dynamic install plane
   - Template bootstrap plane
2. Runtime dependency mutation path in `packages/opencode/src/config/config.ts`.
3. Current coupling risks:
   - Non-published version pin risk for `@opencode-ai/plugin`
   - Floating specifier risk (`*`)
   - Split state across repo lockfile and user-space manifests

## Output

- Updated `docs/ARCHITECTURE.md` with new chapter:
  - `## 14. External Dependency Inventory (2026-02-21)`

## Next

- Use this baseline to design dependency decoupling plan (policy + migration + fallback behavior).
