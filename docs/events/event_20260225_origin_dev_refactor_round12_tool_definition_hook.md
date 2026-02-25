# Event: origin/dev refactor round12 (tool definition hook)

Date: 2026-02-25
Status: Done

## Source behavior

- Upstream reference: `1608565c808c9136bdc6930a356649bd9824cc69`
- Intent: allow plugins to customize tool definitions (description/parameters) before model exposure.

## Rewrite-only port in cms

- `packages/opencode/src/tool/registry.ts`
  - During tool materialization, initialize tool once, then emit `Plugin.trigger("tool.definition", { toolID }, output)`.
  - Apply plugin-mutated `description` and `parameters` into final tool object returned to runtime.

- `packages/plugin/src/index.ts`
  - Added `tool.definition` hook type:
    - input: `{ toolID: string }`
    - output: `{ description: string; parameters: any }`

## Additional analysis decision

- `56ad2db02055955f926fda0e4a89055b22ead6f9`: integrated.
  - `tool.execute.after` args payload already exists through current ToolInvoker path in cms.

## Validation

- `bun test packages/opencode/test/tool/registry.test.ts`
  - first run had one baseline 5s timeout
  - re-run with `--timeout 20000`: all pass
- `bun run packages/opencode/src/index.ts --help` ✅
