# Event: Batch-6 Phase E6-B rewrite-port (app-side Windows/Cygwin follow-up)

Date: 2026-02-27
Status: Done

## Scope

- Upstream anchor: `a74fedd23` app-side deltas not included in E6-A

## Changes

- `packages/app/src/context/file/path.ts`
  - normalize now canonicalizes root/path separators to `/` before prefix stripping, and keeps Windows comparison case-insensitive for drive roots.
- `packages/app/src/context/file/path.test.ts`
  - Windows mixed-separator assertions updated to stable slash-normalized outputs (`src/app.ts`).
- `packages/app/src/pages/session.tsx`
  - added `reviewEmptyKey()` and use it in review-empty UI to distinguish no-vcs projects.
- `packages/app/src/i18n/en.ts`
  - added `session.review.noVcs` string.

## Validation

- `bun test packages/app/src/context/file/path.test.ts` ✅
- `bun turbo typecheck --filter=@opencode-ai/app --filter=@opencode-ai/ui` ✅

## Notes

- Rewrite-only policy respected (no merge/cherry-pick).
