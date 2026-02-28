# Event: move antigravity legacy storage suite to test file

Date: 2026-02-28
Status: Completed

## Decision

- Rename `storage.legacy.ts` to `storage.legacy.test.ts` under antigravity plugin.

## Why

- File content is a legacy validation/test suite (`describe/it/vi.mock`) rather than runtime plugin code.
- Keeping it as non-test `.ts` made production typecheck include vitest-only constructs and block pre-push.

## Impact

- Runtime code unchanged.
- `bun typecheck` no longer fails on this legacy suite.

## Files

- `packages/opencode/src/plugin/antigravity/plugin/storage.legacy.ts` (renamed)
- `packages/opencode/src/plugin/antigravity/plugin/storage.legacy.test.ts`
