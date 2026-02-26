# Event: Batch-4 Phase E4-B rewrite-port (app+test stability)

Date: 2026-02-27
Status: Done

## Scope

- `eda71373b` app: wait for loadFile before opening file tab
- `a592bd968` fix: update createOpenReviewFile test call order
- `de796d9a0` fix(test): path.join for cross-platform glob assertions
- `79254c102` fix(test): normalize git excludesFile path for Windows
- `ad5f0816a` fix(cicd): flakey typecheck

## Decision summary

- Ported:
  - `eda71373b`
  - `a592bd968`
  - `79254c102`
  - `ad5f0816a`
- Skipped (file absent / already diverged):
  - `de796d9a0` (`packages/opencode/test/util/glob.test.ts` not present in current cms tree)

## Changes

- `packages/app/src/pages/session/helpers.ts`
  - `createOpenReviewFile` now supports async `loadFile` and opens tab after file load resolves.
- `packages/app/src/pages/session/helpers.test.ts`
  - updated expected call order to reflect new async-safe behavior.
- `packages/opencode/test/snapshot/snapshot.test.ts`
  - normalize global `excludesFile` path to forward slashes in git config fixture for Windows compatibility.
- `turbo.json`
  - make `typecheck` depend on `^build` to reduce flaky ordering.

## Validation

- `bun test packages/opencode/test/snapshot/snapshot.test.ts` ✅
- `bun test packages/app/src/pages/session/helpers.test.ts` ⚠️ existing no-DOM runtime issue (`document is not defined`)
- `bun turbo typecheck --filter=@opencode-ai/app --filter=opencode --filter=@opencode-ai/ui` ✅

## Notes

- Rewrite-only policy respected (no merge/cherry-pick).
