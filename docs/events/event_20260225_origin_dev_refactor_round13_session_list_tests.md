# Event: origin/dev refactor round13 (session list filter coverage)

Date: 2026-02-25
Status: Done

## Source behavior

- Upstream reference: `8631d6c01d8c8f5e8c616e09e85e5a27791d1a56`
- Intent: add stronger test coverage for session list filter behavior.

## Rewrite-only port in cms

- `packages/opencode/test/server/session-list.test.ts`
  - Added coverage for:
    - `roots=true`
    - `search=<term>`
    - `start=<timestamp>`
    - `limit=<n>`
  - Kept existing route-level style (`Server.App()` + HTTP request assertions) to match cms architecture.

## Additional analysis decision

- `b020758446254e6c03b0182247b611ce1e5f2c55`: integrated.
  - Current cms already lists sessions across project directories by default.

## Validation

- `bun test packages/opencode/test/server/session-list.test.ts`
  - first run had baseline 5s timeout in one test
  - re-run with `--timeout 20000`: all pass
