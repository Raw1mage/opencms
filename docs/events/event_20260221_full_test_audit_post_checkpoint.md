# Event: Full test audit after checkpoint commits

- **Date**: 2026-02-21
- **Status**: In Progress
- **Scope**: Repository-wide test run (`bun run test`)

## Result snapshot

- Full test run did not complete (terminated by timeout/SIGTERM after failures).
- Observed fail lines before termination: **30**.

## Top failing areas (by file)

1. `packages/opencode/src/plugin/antigravity/plugin/accounts.test.ts` (8)
2. `packages/opencode/test/provider/transform.test.ts` (7)
3. `packages/opencode/test/server/session-select.test.ts` (3)
4. `packages/opencode/test/config/agent-color.test.ts` (2)
5. Remaining single-fail files:
   - `packages/opencode/test/permission-task.test.ts` (timeout case)
   - `packages/opencode/test/tool/read.test.ts`
   - `packages/opencode/test/session/structured-output.test.ts`
   - `packages/opencode/test/session/compaction.test.ts`
   - `packages/opencode/test/session/retry.test.ts`
   - `packages/opencode/test/session/prompt-missing-file.test.ts`
   - `packages/opencode/test/session/llm-cms-stream.test.ts` (intermittent in full run)
   - `packages/opencode/test/server/session-list.test.ts`
   - `packages/opencode/src/plugin/anthropic-cli.test.ts`
   - `packages/opencode/src/plugin/anthropic.test.ts`

## Notes

- Failures are currently dominated by:
  - Antigravity account strategy/rate-limit expectation drift.
  - Provider transform expectation mismatch.
  - Session/tui endpoint expectation drift.
