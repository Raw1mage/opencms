# Event: Antigravity legacy storage typecheck unblock

Date: 2026-02-26
Status: Done

## Summary

- Fixed `packages/opencode/src/plugin/antigravity/plugin/storage.legacy.ts` typecheck blockers that were preventing pre-push from passing.
- Replaced direct `vitest` import with guarded `globalThis` test bindings to avoid runtime package dependency during normal typecheck.
- Added explicit callback parameter types for mocked call-site lookups to satisfy `noImplicitAny`.

## Validation

- `bun run typecheck` in `packages/opencode` passed.
