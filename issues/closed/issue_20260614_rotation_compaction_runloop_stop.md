# BR: Rotation plus compaction at 15:13 stopped the runloop until the user sent another message

- **Date**: 2026-06-14
- **Severity**: high
- **Status**: closed
- **Component**: opencode session runtime — rotation3d / provider-switched compaction / prompt runloop continuation
- **Reporter**: pkcs12 (live observation in this session)

## Summary

At ~15:13, a rotation event coincided with compaction. After that rotation+compaction boundary, the runloop stopped instead of continuing the current user turn. The assistant did not respond to the first post-event message; only after the user sent a second message did the session resume and the assistant continued.

This appears related to the provider-switch / account-rotation compaction path, where `provider-switched` is treated as a rebind-class maintenance trigger. Architecture currently says restart / rebind / account-rotation recover by scanning the message stream for the most recent anchor and slicing forward, and that provider-switched compaction has `INJECT_CONTINUE=false`. That is safe against infinite loops, but the 15:13 observation suggests the first live user turn can still be stranded after rotation+compaction.

## Timeline

| Time  | Event                                                                      |
| ----- | -------------------------------------------------------------------------- |
| 15:13 | Rotation and compaction occurred in the same boundary window.              |
| 15:13 | Runloop stopped / produced no assistant response after the user's message. |
| After | User sent a second message; assistant resumed normally.                    |

## Expected behavior

- Rotation-triggered compaction must not consume or strand the current user turn.
- After provider/account rotation plus compaction, the runloop should either continue with the same user message or explicitly replay/project it after the new anchor.
- If continuation is intentionally suppressed for safety, the runtime should emit an observable stop reason that names the boundary state, not silently wait for a second user message.

## Actual behavior

- The first user message after the 15:13 rotation+compaction event received no assistant response.
- The next user message caused the assistant to resume, implying the session itself was healthy but the prior runloop iteration terminated early.

## Suspected affected path

- `rotation3d` / rate-limit fallback chooses or pins a new execution identity.
- Prompt runloop derives `observed="provider-switched"` from pinned identity vs most recent anchor identity.
- `SessionCompaction.run({ observed: "provider-switched" })` writes a narrative anchor via `compactWithSharedContext` / `writeAnchorFromBody`.
- `INJECT_CONTINUE["provider-switched"] === false`, so the runloop may stop after compaction unless the current user turn is safely projected/replayed after the new anchor.

## Evidence to collect

1. Runtime log around 2026-06-14 15:13 for `rotation3d`, `provider-switched`, `compaction.snapshot`, `compact done`, `diag.preLLM`, and any `no_user_after_compaction` / boundary-stop event.
2. Session DB message ordering around the same timestamp: original user message, compaction anchor, replay marker if any, and subsequent second user message.
3. Whether the most recent anchor identity differs from the newly pinned execution identity immediately before the stop.

## Acceptance criteria

1. A regression test reproduces rotation/provider-switched compaction while a user turn is pending, and verifies the first user message remains visible to the next LLM call.
2. Rotation+compaction no longer requires a second user message to resume the runloop.
3. If the runtime stops by design, it records an explicit observable reason with enough message-boundary evidence to diagnose the stop.

## Related context

- `specs/architecture.md` documents that anchors live in the message stream and that restart / rebind / account-rotation recover by scanning the most recent anchor and slicing forward.
- `specs/architecture.md` also documents `INJECT_CONTINUE=false` for `provider-switched`, originally to prevent compaction infinite loops.
- Related fixed BR: `issues/issue_20260614_compaction_anchor_rollback_replays_round.md`.

## RCA (2026-06-14)

This incident was initially filed as “rotation+compaction stopped the runloop”, but the session DB shows a more precise failure chain:

1. At 15:09:42 the previous assistant response completed normally with `tokens_input=187894`, putting the next turn in high context pressure.
2. At 15:13:29 the user asked: `確認一下rotation的時候有沒有compaction的觸發點？我記得應該會做個簡單的壓縮`.
3. At 15:13:30 the runtime created an empty assistant message under the new account `codex-subscription-service-thesmart-cc`, reflecting the account rotation boundary.
4. At 15:13:31 the runtime wrote an auto compaction request, a narrative summary anchor, and a replayed post-anchor copy of the user message with `metadata.compactionReplay=true`.
5. The replay worked: the next LLM call saw the replayed user and produced two tool-call turns at 15:13:31 and 15:13:40.
6. At 15:13:46 a third assistant message was created, but it never received parts, `finish`, or `time_completed`.
7. At 15:13:52 the daemon restarted as part of the controlled 3R deploy. On boot, `resumePendingContinuations` reported `count=0`, because ordinary interactive chat turns are not represented in the workflow continuation queue.
8. `ZombieSweep` is disabled at daemon start (`zombie sweep disabled (long-thinking tool calls)`), so the incomplete assistant row remained `finish=NULL / time_completed=NULL` instead of being stamped as interrupted.
9. The user sent another message at 15:23:42, which started a fresh runloop and resumed normal operation.

### Root cause

The current controlled restart path does not have a recovery contract for an ordinary interactive prompt that is in-flight during daemon shutdown/restart. Workflow continuations are resumed, but normal chat generations are not queued. Because zombie sweep is disabled, the interrupted assistant row also remains indistinguishable from an in-flight row until another user turn starts a new runloop.

Rotation and compaction were contributing conditions, not the direct stopping cause:

- Account rotation changed the execution account from `codex-subscription-developer-thesmart-cc` to `codex-subscription-service-thesmart-cc`.
- Context pressure caused an auto compaction/replay boundary.
- The replay invariant held: the current user message was preserved after the anchor.
- The actual stop happened when 3R restarted the daemon while the third post-compaction assistant turn was in-flight.

### Corrected affected path

- `Session.prompt` starts an ordinary interactive runloop.
- High-token turn triggers auto compaction and user-message replay.
- The runloop continues and creates a new assistant message.
- Controlled restart terminates the daemon before that assistant message is completed.
- Boot only calls workflow continuation recovery; it does not resume ordinary in-flight chat prompts.
- Zombie sweep is disabled, so the incomplete assistant row is not marked interrupted.

### Fix direction

1. Add a restart-handover/recovery contract for ordinary interactive prompts, or explicitly mark in-flight normal prompts as interrupted during controlled shutdown.
2. Avoid re-enabling the old blanket 60s `ZombieSweep` as-is; its own comment documents false positives for long-thinking tool calls.
3. Prefer a restart-scoped marker: only stamp messages known to belong to a prior daemon lifecycle, not messages merely older than a time threshold.
4. Add a regression test where a controlled restart happens after compaction replay but before assistant completion; expected outcome is either resumable dispatch or an explicit interrupted assistant state, not a silent wait for a second user message.

## Closure (2026-06-14)

Closed as no compaction fix required. RCA showed compaction replay preserved the user prompt and the runloop continued for two tool-call turns. The apparent stop was caused by a controlled 3R daemon restart interrupting an ordinary in-flight chat turn. Any future work belongs under restart UX / observability, not compaction correctness.
