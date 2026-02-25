# Event: origin/dev refactor round21 (ACP pending status dedupe)

Date: 2026-02-25
Status: Done

## Source behavior

- Upstream reference: `2cee947671fa373098db308b173c859cada0b108`
- Intent: make ACP live-stream and replay paths share one synthetic pending status for tool calls, avoiding duplicates.

## Rewrite-only port in cms

- `packages/opencode/src/acp/agent.ts`
  - Added `toolStarts` dedupe set.
  - Added `toolStart(sessionId, part)` helper that emits a single `tool_call` pending event per `callID`.
  - Updated both live event handler (`message.part.updated`) and replay path (`processMessage`) to call `toolStart(...)` for pending/running tool states.
  - Clears dedupe marker on terminal states (`completed` / `error`).

- `packages/opencode/test/acp/event-subscription.test.ts`
  - Added regression test: `does not emit duplicate synthetic pending after replayed running tool`.
  - Added reusable `toolEvent(...)` helper and captured `sessionUpdates` for precise event-sequence assertions.

## Validation

- `bun test packages/opencode/test/acp/event-subscription.test.ts --timeout 30000` ✅
- `bun run packages/opencode/src/index.ts acp --help` ✅
