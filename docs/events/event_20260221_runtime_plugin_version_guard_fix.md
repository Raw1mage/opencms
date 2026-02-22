# Event: Runtime plugin version guard fix

- **Date**: 2026-02-21
- **Status**: Done
- **Scope**: `packages/opencode/src/config/config.ts`

## Symptom

- Runtime dependency manifests were repeatedly rewritten to non-published plugin versions like `0.0.0-cms-*`.
- Subsequent `bun install` in runtime directories failed with version resolution errors.

## Root Cause

- Runtime install flow directly used `Installation.VERSION` as `@opencode-ai/plugin` target version for non-local channels.
- CMS app build tags are not guaranteed to correspond to published plugin package versions.

## Fix

1. Added `runtimePluginVersionTarget()` in config runtime install path.
2. Policy:
   - local build => `*`
   - custom pre-release-like app tags starting with `0.0.0-` => `latest`
   - otherwise => `Installation.VERSION`
3. Reused same target policy in both:
   - `installDependencies()`
   - `needsInstall()`

## Validation

- `bun turbo typecheck --filter opencode` passed.

## Notes

- This is a hotfix guard to stop recurring runtime breakage. Follow-up work should replace `latest` fallback with policy-driven pinned baseline/resolver.
