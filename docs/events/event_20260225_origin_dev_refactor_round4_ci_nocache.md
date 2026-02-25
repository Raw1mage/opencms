# Event: origin/dev refactor round4 (CI no-cache install hardening)

Date: 2026-02-25
Status: Done

## Source behavior

- Upstream reference: `da40ab7b3d242208b5c759e55e548c13c658372a`
- Intent: in CI environments, disable Bun cache during dependency install to reduce stale-cache failures.

## Rewrite-only port in cms

- `packages/opencode/src/bun/index.ts`
  - add CI-aware `--no-cache` for package add path: `proxied() || process.env.CI`
- `packages/opencode/src/config/config.ts`
  - add CI-aware `--no-cache` for plugin dependency `bun install`

## Validation

- `bun run packages/opencode/src/index.ts --help`
- `bun test packages/opencode/test/config/config.test.ts`
  - Baseline note: first run had 3 tests timeout at 5s.
  - Re-run those 3 tests with `--timeout 20000`: all pass.
