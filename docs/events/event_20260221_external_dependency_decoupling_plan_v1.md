# Event: External dependency decoupling plan v1

- **Date**: 2026-02-21
- **Status**: Drafted
- **Scope**: Architecture planning only (no code behavior changes)

## Context

Following runtime failure caused by non-published plugin version pinning, we drafted a staged decoupling plan to reduce runtime dependency fragility.

## Decisions

1. Treat dependency management as three planes:
   - monorepo
   - template
   - runtime user-space
2. Prioritize runtime-plane hardening first.
3. Use phased rollout:
   - Phase 0 guard/fallback
   - Phase 1 version source decoupling
   - Phase 2 manifest governance
   - Phase 3 optional bundling/offline mode

## Output

- Added architecture chapter:
  - `docs/ARCHITECTURE.md` → `## 15. External Dependency Decoupling Plan (Draft v1)`

## Next

- Convert draft into implementation tickets with owner, timeline, and acceptance tests.
