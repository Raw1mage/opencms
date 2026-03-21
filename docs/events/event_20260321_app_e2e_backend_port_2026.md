# Event: app e2e backend port fixed to 2026

Date: 2026-03-21
Status: Done

## Scope

- Formalize the app/Playwright agent-run e2e backend port as `2026`.
- Preserve explicit env override behavior for e2e-only backend wiring.

## Changes

- `packages/app/script/e2e-local.ts`
  - stopped selecting a random backend port for agent-run e2e.
  - default backend port is now `2026`, with existing env override inputs still honored.
- `packages/app/playwright.config.ts`
  - updated Playwright backend port default to `2026`.
- `packages/app/e2e/utils.ts`
  - updated shared e2e backend port default to `2026`.
- `packages/app/README.md`
  - updated e2e backend port documentation to `2026`.

## Validation

- `bun run typecheck` (packages/app) ✅
- `bunx playwright test --list` (packages/app) ✅

## Architecture Sync

- Architecture Sync: Verified (No doc changes)
- Rationale: this change formalizes app/Playwright e2e backend port defaults only; it does not alter runtime architecture, module boundaries, or telemetry/data-flow ownership.

## Notes

- Frontend/Vite port behavior remains unchanged.
