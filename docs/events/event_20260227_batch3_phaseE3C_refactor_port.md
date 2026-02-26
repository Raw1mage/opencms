# Event: Batch-3 Phase E3-C rewrite-port (win32 build/publish scripts)

Date: 2026-02-27
Status: Done

## Scope

- `34495a70d` fix(win32): scripts/turbo commands would not run
- `3201a7d34` fix(win32): add bun prefix to console app build scripts

## Changes

- `packages/plugin/script/publish.ts`
  - use `fileURLToPath(new URL(...))` for Windows-safe directory resolution.
- `packages/sdk/js/script/build.ts`
  - use `fileURLToPath(new URL(...))` for Windows-safe directory resolution.
- `packages/sdk/js/script/publish.ts`
  - use `fileURLToPath(new URL(...))` for Windows-safe directory resolution.
- `packages/sdk/js/package.json`
  - prefix build script with `bun` (`bun ./script/build.ts`).
- `packages/console/app/package.json`
  - prefix build scripts with `bun` for sitemap generation and schema step.

## Notes

- `script/publish.ts` already had `fileURLToPath` path handling in current cms baseline; no delta required in this phase.

## Validation

- `bun turbo typecheck --filter=@opencode-ai/plugin --filter=@opencode-ai/sdk --filter=@opencode-ai/console-app` ✅
