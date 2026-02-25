# Event: origin/dev refactor round3 (rewrite-only behavior ports)

Date: 2026-02-25
Status: Done

## Scope

- Continue origin/dev -> cms refactor workflow under strict rewrite-only policy.
- No direct upstream code transplant workflow.

## Upstream behaviors ported

1. `088a81c116f3fda865851292c92754385292b92d`
   - Topic: auth login stdout/exit concurrency safety
   - cms refactor: in `packages/opencode/src/cli/cmd/auth.ts`, guard missing stdout and consume `proc.exited` + stdout text concurrently.

2. `e7182637784b7d558657da5b6aede92f0db1c11f`
   - Topic: ensure git id cache persistence completes
   - cms refactor: in `packages/opencode/src/project/project.ts`, await write of `.git/opencode` cache id.

3. `3af12c53c433d1f49abde0874dc02c2e6c018930`
   - Topic: custom tool import compatibility for absolute paths
   - cms refactor: in `packages/opencode/src/tool/registry.ts`, import via `pathToFileURL(match).href`.

## Validation

- `bun test packages/opencode/test/project/project.test.ts`
- `bun run packages/opencode/src/index.ts --help`
