# Event: Pre-push opencode build script path fix

Date: 2026-02-27
Target: `cms`

## Scope

- Fix pre-push hook failure caused by missing script path in workspace package build command.

## Changes

1. `packages/opencode/package.json`
   - Updated `scripts.build` from `bun run script/build.ts` to `bun run ../../script/build.ts`.

## Validation

- Pending push retry (pre-push runs `bun turbo typecheck`).
