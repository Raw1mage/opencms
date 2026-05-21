# Bug: Large runloop appears to change conversation message IDs and moves visible output away from bottom

Status: Closed

## Summary

After a large agent runloop, the conversation UI appeared to lose or change the expected message/output identity used for display anchoring. New visible assistant text was rendered several pages above the bottom of the conversation instead of appearing at the latest bottom position.

## Impact

- User could not reliably see the newest response at the bottom of the page.
- The UI looked as if the assistant had responded “in the past” or inserted text into an older location.
- This increases confusion during long autonomous runs, especially when many tool calls and repeated messages are involved.
- It makes it harder to tell whether the run is still active, stalled, or finished.

## Observed Scenario

- Date: 2026-05-18 Asia/Taipei.
- Active work repo: `/home/pkcs12/projects/drawmiat`.
- Issue target repo: `/home/pkcs12/projects/opencode`.
- The session had a large runloop while debugging Grafcet renderer L3 routing regressions.
- The session included many tool calls, repeated `todowrite` updates, duplicate visible text, compaction/amnesia context, and multiple user interrupts.
- After the runloop, a visible response appeared not at the bottom of the conversation, but several pages higher in the transcript.
- Follow-up clarification: the issue appeared only on the first conversation turn immediately after the runloop ended.
- The misplaced response was anchored roughly four conversation turns above the expected latest/bottom position.

## User Report

The user described the symptom as:

> 經過一個較大的runloop後，對話輸出入串的ID好像被改變了。導致顯示文字的位置跑到頁面上捲好幾頁的地方，而不是在最底端。

Additional clarification:

> 只有runloop剛結束後的第一輪對話有這個問題。大約回退了四輪對話的位置。

## Relevant Session Context

This happened after another bug in the same session where the main agent repeated similar status messages/tool calls, consuming tokens/time. That earlier report is recorded at:

- `issues/bug_20260518_session_repetition_loop.md`

The scroll-anchor/message-position bug may be related because the session contained:

- Long runloop continuation.
- Many sequential and parallel tool calls.
- Duplicate assistant preambles and duplicate final messages.
- Mid-run user messages delivered through system reminders.
- Context compaction with recoverable tool-call history.
- Todo ledger rewrites and status updates.

## Suspected Failure Mode

Possible areas to inspect:

- Message ID stability across long runloop continuation turns.
- UI anchoring logic that maps streamed assistant/tool output to DOM nodes.
- Handling of synthetic continuation/system-reminder messages in the conversation tree.
- Whether a resumed/continued assistant message keeps the same ID while visible content is appended later.
- Whether duplicate assistant outputs with identical content confuse virtualized list keying.
- Whether compaction or runloop resume mutates parent/child message relationships.
- Whether tool-call completion output and assistant text output are inserted using different chronological anchors.
- Whether the first post-runloop user/assistant exchange reuses a stale anchor from several turns earlier, while later turns recover normal bottom anchoring.

## Expected Behavior

- Latest assistant-visible text should appear at the bottom of the active conversation.
- Large runloops should not reorder, re-anchor, or visually insert new assistant text into older transcript positions.
- Message IDs used as UI keys should remain stable and monotonic for display ordering.
- If content is appended to an existing assistant turn, the UI should still scroll/focus to that updated message predictably.

## Actual Behavior

- After a large runloop, visible text appeared several pages above the bottom.
- The misplaced text appeared only on the first turn after runloop completion.
- The observed displacement was about four conversation turns upward.
- The user suspected the input/output stream ID changed or was reused incorrectly.
- The UI did not present the latest response where the user expected it.

## Reproduction Sketch

1. Start a long coding/debugging run in a repo.
2. Trigger many tool calls, todo updates, and visible progress messages.
3. Interrupt mid-run with user messages, including corrections and a stop/resume sequence.
4. Allow a large continuation/runloop to complete.
5. Send one normal user message immediately after runloop completion.
6. Observe whether the first post-runloop assistant response is rendered at the bottom or inserted around four turns earlier.
7. Send another follow-up message and check whether anchoring recovers on later turns.

## Useful Diagnostics To Add

- Log message IDs, parent IDs, created timestamps, and insertion indexes for every visible assistant text chunk.
- Log whether a text chunk appends to an existing message or creates a new message.
- Log runloop resume/session continuation boundaries.
- Log UI virtualized-list keys and scroll anchor target IDs when new assistant text arrives.
- Detect if a new visible text chunk is attached to a non-last message while the session is active.
- Specifically compare the first post-runloop turn with the second post-runloop turn; the bug may be a stale-anchor cleanup issue at runloop exit rather than a persistent rendering bug.

## Suggested Priority

High. This affects trust and usability during exactly the long autonomous/debugging runs where users most need reliable progress visibility.

## Closure

Closed 2026-05-21. The confirmed reproduction shared the same frontend ordering boundary as the round-tail/chain-reset report: message ids can be non-monotonic and local/snapshot merge order could append older snapshot-only messages after the current tail. Fix and verification are recorded in `docs/events/event_20260520_round_tail_chain_reset.md` with `bun test packages/app/src/context/active-poll.test.ts` passing.
