# Repo-wide verification blockers

Date: 2026-05-01

## Summary

During the system-manager DB dialog refactor validation, focused checks passed, but repo-wide verification could not complete due to existing environment/template blockers outside the system-manager change scope.

## Blockers

### 1. `bun run verify:typecheck` cannot find `turbo`

- Command attempted: `bun run verify:typecheck`
- Observed failure: repo checkout could not resolve the `turbo` executable.
- Scope: environment/dependency verification issue; not observed in focused system-manager checks.
- Suggested next step: verify dependency installation and package script resolution for `turbo` before relying on repo-wide typecheck.

### 2. Repo-wide `tsc --noEmit` blocked by plan-builder template syntax errors

- Command attempted: `bun tsc --noEmit`
- Observed failure: existing syntax errors in `templates/skills/plan-builder/scripts/plan-rollback-refactor.ts` blocked full typecheck.
- Scope: template/skill script issue, outside the system-manager DB dialog refactor files.
- Suggested next step: inspect and fix `templates/skills/plan-builder/scripts/plan-rollback-refactor.ts`, then rerun repo-wide typecheck.

## Current validation status for system-manager refactor

- Passed: `bun test packages/mcp/system-manager/src/system-manager-http.test.ts packages/mcp/system-manager/src/system-manager-session.test.ts`
- Passed: `bun --check packages/mcp/system-manager/src/index.ts && bun --check packages/mcp/system-manager/src/system-manager-http.ts`
- Passed: `bun eslint packages/mcp/system-manager/src/index.ts packages/mcp/system-manager/src/system-manager-http.ts packages/mcp/system-manager/src/system-manager-http.test.ts`
