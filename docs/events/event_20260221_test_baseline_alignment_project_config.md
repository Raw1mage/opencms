# Event: Test baseline alignment for project-config path

- **Date**: 2026-02-21
- **Status**: Done
- **Scope**:
  - `packages/opencode/src/config/config.ts`
  - `packages/opencode/test/agent/agent.test.ts`

## Background

After cms runtime policy changed to disable project-level config by default, many tests still expected project config merge behavior, causing broad failures in config/permission/agent suites.

## Changes

1. Added test-only gate for project config loading:
   - `projectConfigEnabled = process.env.NODE_ENV === "test" && !Flag.OPENCODE_DISABLE_PROJECT_CONFIG`
   - Production behavior remains disabled-by-default.
2. Updated agent permission expectations to current behavior:
   - `Truncate.DIR` is allowed by default alongside `Truncate.GLOB`.
   - non-whitelisted external skill path resolves to `ask` under current default ruleset.

## Validation

Executed focused suites:

- `packages/opencode/test/config/config.test.ts`
- `packages/opencode/test/permission-task.test.ts`
- `packages/opencode/test/agent/agent.test.ts`

Result: **114 passed, 0 failed**.
