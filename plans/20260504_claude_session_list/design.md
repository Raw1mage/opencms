# Design: Claude Session List

## Context

Phase 6 extends the existing Claude Code native takeover adapter with compaction-aware import behavior. The existing compaction subsystem already defines the durable anchor contract: the message stream is the single source of truth, and anchors are assistant messages with `summary: true`.

## Decisions

- **DD-1** Use existing message-stream anchors for takeover compaction. Do not add a Claude-specific sidecar compaction store.
- **DD-2** Import-time takeover anchors are deterministic summaries derived from normalized transcript text and bounded tool evidence. They must not call an LLM during discovery/listing.
- **DD-3** Anchor idempotency is keyed by source transcript line range. Re-importing unchanged source lines must not create a new anchor.
- **DD-4** Raw imported transcript messages remain in the session for UI/audit; `MessageV2.filterCompacted` controls only LLM-visible history by selecting the latest summary anchor.
- **DD-5** Anchor metadata may live in import metadata and text-part metadata, but the anchor itself must be readable as a normal assistant summary message.

## Critical Files

- `packages/opencode/src/session/claude-import.ts`
- `packages/opencode/src/session/compaction.ts`
- `packages/opencode/src/session/memory.ts`
- `packages/opencode/src/session/message-v2.ts`
- `packages/opencode/test/server/session-list.test.ts`
- `plans/20260504_claude_session_list/*`

## Risks

- Writing a malformed summary anchor can hide too much raw transcript from the next LLM call.
- Reusing normal compaction mode incorrectly could inject synthetic continuation messages during import; Phase 6 must write only the anchor, not trigger runloop continuation.
- Delta sync must avoid duplicate anchors for unchanged line ranges.
- Existing UI expects raw messages to remain visible; compaction must not delete imported messages.

## Validation

- Focused import tests create a large transcript and assert an assistant `summary: true` anchor exists.
- `MessageV2.filterCompacted` on the imported session returns the anchor plus post-anchor delta, not the whole pre-anchor transcript.
- No-op reimport keeps anchor count stable.
- Delta reimport appends raw messages and creates a new superseding anchor only when the line range advances past the anchor threshold.
