# Event: origin/dev refactor item - plugin dependency resilience

Date: 2026-02-23
Status: Done

## Source

- `93615bef2` fix(cli): missing plugin deps cause TUI to black screen

## Refactor

- `packages/opencode/src/config/config.ts`
  - normalized dependency-install warning log to explicit failure wording and structured `error` field.
- `packages/opencode/src/plugin/index.ts`
  - hardened plugin install error extraction by preferring nested error cause details when available.

## Why

- Improves diagnosis quality when plugin dependency install/load fails.
- Reduces opaque failures that can cascade into blank TUI startup states.

## Validation

- `bun run --cwd /home/pkcs12/projects/opencode/packages/opencode typecheck`
  - reports known antigravity baseline noise only (`storage.legacy.ts`), excluded per project rule.
