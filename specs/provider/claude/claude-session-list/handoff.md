# Handoff: Claude Session List

## Execution Contract

Phase 6 implements Claude takeover compaction/anchor support. Build only against the existing message-stream compaction contract.

## Required Reads

- `plans/20260504_claude_session_list/proposal.md`
- `plans/20260504_claude_session_list/implementation-spec.md`
- `plans/20260504_claude_session_list/design.md`
- `plans/20260504_claude_session_list/tasks.md`
- `packages/opencode/src/session/claude-import.ts`
- `packages/opencode/src/session/compaction.ts`
- `packages/opencode/src/session/memory.ts`
- `packages/opencode/src/session/message-v2.ts`
- `packages/opencode/test/server/session-list.test.ts`

## Stop Gates

- Stop if implementation would require a new non-message-stream compaction persistence store.
- Stop if unknown Claude transcript blocks must be summarized rather than fail-fast normalized.
- Stop if anchor creation requires daemon/gateway restart before tests can run.
- Stop if `filterCompacted` behavior would need a breaking contract change for non-Claude sessions.

## Validation Commands

- `OPENCODE_SERVER_PASSWORD= bun test --timeout 15000 packages/opencode/test/server/session-list.test.ts`
- `bun run typecheck` in `packages/app` only if frontend fields are changed.

## Completion Gate

- Phase 6 tasks in `tasks.md` are checked.
- Event log records implementation, root cause, validation, and architecture sync.
- `specs/architecture.md` documents the takeover anchor extension or explicitly records no architecture change.
