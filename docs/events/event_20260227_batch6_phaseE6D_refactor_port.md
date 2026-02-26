# Event: Batch-6 Phase E6-D rewrite-port (win32 e2e localhost stability)

Date: 2026-02-27
Status: Done

## Scope

- `0a9119691` fix(win32): e2e sometimes fails because localhost may resolve to IPv6

## Changes

- `packages/app/e2e/utils.ts`
  - default `PLAYWRIGHT_SERVER_HOST` changed from `localhost` to `127.0.0.1`.
- `packages/app/playwright.config.ts`
  - default `baseURL` changed to `http://127.0.0.1:<port>`.
  - default `PLAYWRIGHT_SERVER_HOST` changed from `localhost` to `127.0.0.1`.

## Validation

- `bun turbo typecheck --filter=@opencode-ai/app` ✅

## Notes

- Rewrite-only policy respected (no merge/cherry-pick).
