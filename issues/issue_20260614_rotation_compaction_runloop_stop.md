# BR: Rotation plus compaction at 15:13 stopped the runloop until the user sent another message

- **Date**: 2026-06-14
- **Severity**: high
- **Status**: open
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
