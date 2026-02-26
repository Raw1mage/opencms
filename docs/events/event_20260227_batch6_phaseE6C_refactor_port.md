# Event: Batch-6 Phase E6-C rewrite-port (layout project-switch stability)

Date: 2026-02-27
Status: Done

## Scope

- Upstream anchor: `b4d0090e0` (fix flaky project-switch behavior)

## Changes

- `packages/app/src/pages/layout/helpers.ts`
  - added `latestRootSession()` helper for selecting newest root session across multiple stores.
- `packages/app/src/pages/layout/helpers.test.ts`
  - added coverage for latest-root-session selection and archived/child filtering.
- `packages/app/src/pages/layout.tsx`
  - `navigateToProject()` now:
    - resolves project root from worktree/sandbox context,
    - attempts remembered session restore,
    - falls back to latest root session from in-memory stores,
    - falls back to fetched latest root session from SDK,
    - otherwise opens project session root.
  - improves project switch consistency for latest-session landing.

## Validation

- `bun test packages/app/src/pages/layout/helpers.test.ts` ✅
- `bun turbo typecheck --filter=@opencode-ai/app` ✅

## Notes

- Rewrite-only policy respected (no merge/cherry-pick).
