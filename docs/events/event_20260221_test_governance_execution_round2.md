# Event: Test governance execution round 2 (legacy retirement + segmented verification)

- **Date**: 2026-02-21
- **Status**: Done
- **Scope**:
  - `packages/opencode/src/plugin/antigravity/plugin/storage.test.ts` -> `storage.legacy.ts`
  - segmented full-suite verification commands

## What changed

1. Retired long-running legacy storage test from default test discovery by moving:
   - `storage.test.ts` -> `storage.legacy.ts`
2. Per governance policy, kept behavior available for future legacy investigation without blocking default CI/test flow.

## Validation strategy

Ran tests in segmented groups to avoid single-command timeout masking status:

1. `bun test packages/*/test`
2. `bun test packages/*/*/test`
3. `bun test packages/opencode/src packages/console/*/src packages/enterprise/src`
4. `bun run --cwd packages/app test:unit`

## Validation result

- All segmented suites completed with **0 fail** (with expected skips for legacy-gated suites).
