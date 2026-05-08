# Implementation Spec

## Goal

- Make daemon restart + session continuation resilient to code updates by detecting stale state, recovering orphan tasks, and normalizing historical tool call formats.

## Scope

### IN

- Session version guard on load
- Orphan ToolPart recovery after restart
- Worker pre-bootstrap diagnostics
- Historical tool call input normalization in LLM context
- Execution identity account validation

### OUT

- Compaction checkpoint cross-model validation
- Session storage architecture refactor
- Tool schema versioning system
- Session downgrade support

## Assumptions

- Session.Info.version field is reliably written at creation time (confirmed: index.ts:535)
- ToolPart state is persisted in storage and survives daemon restart (confirmed: message-v2.ts)
- Worker child process stderr is piped to parent (confirmed: task.ts:543-560)
- Tool call inputs in message history are included in LLM context verbatim (confirmed: prompt/llm flow)

## Stop Gates

- If Session.Info schema changes in ways that break Zod parsing of old sessions → must add storage migration first
- If orphan recovery accidentally marks actively-running tasks as failed → need a liveness check mechanism before marking
- If tool input normalization changes the semantic meaning of stored data → must be read-only transform at context assembly time, never write-back

## Critical Files

- `packages/opencode/src/session/index.ts` — Session.get(), Session.Info, version field
- `packages/opencode/src/session/processor.ts` — SessionProcessor, execution identity resolution
- `packages/opencode/src/session/prompt.ts` — message context assembly, prompt loop
- `packages/opencode/src/session/llm.ts` — LLM stream setup, message normalization
- `packages/opencode/src/session/message-v2.ts` — ToolPart schema, ToolState
- `packages/opencode/src/tool/task.ts` — worker lifecycle, spawnWorker, orphan detection
- `packages/opencode/src/cli/cmd/session.ts` — SessionWorkerCommand, bootstrap sequence
- `packages/opencode/src/project/bootstrap.ts` — InstanceBootstrap, init sequence
- `packages/opencode/src/bus/sink.ts` — emitDebug no-op before Bus registration

## Structured Execution Phases

- Phase 1 (Orphan Recovery): Scan stale "running" ToolParts on startup, mark as error, notify parent session
- Phase 2 (Version Guard): Add version check to Session.get(), emit warning metadata, log version drift
- Phase 3 (Worker Observability): Add pre-bootstrap file logger to worker process, bypass Bus dependency
- Phase 4 (Tool Input Normalization): Transform historical tool call inputs at context assembly time to match current schema
- Phase 5 (Execution Identity Validation): Validate account existence before using pinned execution identity

## Validation

- Phase 1: Create a session with a ToolPart in "running" state, restart daemon, verify it gets marked "error"
- Phase 2: Create a session with version "0.0.0", load it with current daemon, verify staleVersion warning in log
- Phase 3: Kill a worker during bootstrap, verify pre-bootstrap log file contains diagnostic timestamps
- Phase 4: Create a session with old-format tool call (patchText), resume session, verify LLM sees normalized format (input)
- Phase 5: Pin a session to a deleted account, resume session, verify graceful fallback instead of 401
- All phases: existing owned-diff.test.ts passes, no regression in session create/load/resume flow

## Handoff

- Build agent must read this spec first.
- Build agent must read companion artifacts (proposal.md, spec.md, design.md, tasks.md) before coding.
- Build agent must materialize runtime todo from tasks.md.
