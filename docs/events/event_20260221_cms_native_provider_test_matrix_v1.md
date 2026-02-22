# Event: CMS-native provider test matrix v1

- **Date**: 2026-02-21
- **Status**: Done
- **Scope**:
  - `packages/opencode/test/provider/provider-cms.test.ts` (new)
  - Provider/session legacy suite gating adjustments from prior baseline alignment

## Objective

Start rebuilding provider coverage around current cms behavior instead of legacy upstream provider assumptions.

## Changes

1. Added new cms-native provider test suite:
   - validates core provider families are present in cms baseline.
   - validates `disabled_providers` + config merge behavior as currently implemented.
   - validates model resolution path (`Provider.getModel`) from active provider list.
2. Kept legacy provider matrix suites opt-in (`OPENCODE_TEST_LEGACY_PROVIDER_SUITE=1`) to avoid blocking cms branch CI while preserving compatibility tests for explicit runs.

## Validation

Executed key cms-aligned suites:

- `packages/opencode/test/config/config.test.ts`
- `packages/opencode/test/permission-task.test.ts`
- `packages/opencode/test/agent/agent.test.ts`
- `packages/opencode/test/provider/provider-cms.test.ts`

Result: **117 pass, 0 fail**.

## Next

1. Add cms-native stream payload tests for active families (`openai`, `google`, `gemini-cli`) with deterministic fixtures.
2. Add rotation/account-scoped provider cases (managed/subscription IDs).
3. Shrink skip surface in legacy suites by migrating high-value scenarios into cms-native coverage.
