# Bug: conversation stream messages render out of chronological order

Status: Closed

## Summary

Conversation stream ordering can become severely incorrect in long sessions. New user messages and assistant responses may render several rounds above their actual position, as if the current exchange was inserted into the middle of an older conversation thread.

## Observed Behavior

- Newly sent user messages and assistant responses appear inside an older part of the transcript instead of appending at the bottom.
- The misplaced exchange can appear several rounds above the current latest turn.
- The transcript looks like a new conversation segment was spliced into a previous long thread.
- This makes it unclear which user prompt an assistant response belongs to.

## Expected Behavior

- New user messages and assistant/tool responses append to the end of the active transcript.
- Transcript entries remain in chronological order across long sessions, compaction, and resumed turns.
- Streaming chunks for the current response attach only to the current response container.

## Impact

- Breaks conversational continuity.
- Makes long debugging / coding sessions unreliable to inspect.
- Can cause the user to believe the agent answered an old prompt or ignored the current prompt.
- Makes RCA difficult because visual ordering no longer matches actual turn order.

## Context

Observed during a long-running session with many tool calls and compacted history. The symptom looked like frontend stream chunks or message records were inserted using a stale ordering anchor rather than appended to the current transcript tail.

## Suspected Areas

- Frontend transcript ordering / stable sort key.
- Streaming message append logic.
- Session compaction / resume handling.
- Message insertion logic using an older message id as anchor.
- Reconciliation between server-side event order and client-side render order.

## Acceptance Criteria

- New streamed exchanges always append after the latest visible turn.
- Existing historical turns are never reordered when a new user message or assistant response arrives.
- Long compacted sessions preserve visual order after resume / continuation.
- The UI can be debugged with a monotonic ordering field or equivalent trace.

## Closure

Closed 2026-05-21. RCA/fix is recorded in `docs/events/event_20260520_round_tail_chain_reset.md`: `mergeSnapshot` now unions local and snapshot messages and sorts by `message.time.created` with an id fallback, and active-poll completion no longer relies on lexicographic message id monotonicity. Regression coverage: `bun test packages/app/src/context/active-poll.test.ts` passed with 10 tests.
