# Design: session_epoch-reset-orphan-hotfix

## Context

OpenCode session runtime produced a "input not responding" symptom on 2026-05-11 (session `ses_1e90d1cb`): an assistant message row was created and prompt telemetry fired, but no `session.round.telemetry` ever followed and the row's `time.completed` stayed NULL. UI hung on "thinking". Forensics also surfaced an in-memory `RebindEpoch.registry` eviction in the same daemon process (two `daemon_start` rebinds with `previousEpoch=0` within 55s, daemon PID unchanged). This hotfix addresses the *user-visible* hang and adds telemetry for the registry-eviction RCA.

## Goals / Non-Goals

**Goals:**
- Unblock UI when an assistant row is left orphan: finalize it, emit a paper-trail event.
- Surface unexpected `RebindEpoch` registry resets as an anomaly event.

**Non-Goals:**
- Diagnose or fix the silent stream death in `LLM.stream` / `processor.process` / SSE wiring.
- Diagnose or fix what evicts the `RebindEpoch.registry` entry mid-session.
- Auto-retry the dead round.

## Risks / Trade-offs

- **False-positive reclaim**: if a stream legitimately takes >5s before its first row update, we could finalize a live round as "error". Mitigation: 5s threshold is generous (rounds normally emit first delta well under 1s); reclaim only fires on user-msg-arrival (not a timer) so a still-streaming round would also keep the round-runtime busy, blocking new user-msg ingestion. Acceptable risk for hotfix.
- **Anomaly noise**: if `RebindEpoch.registry` eviction is actually common (e.g. fired on every session deselect), we'll see anomaly volume. Acceptable — that's the data we need.
- **No retry**: user has to retype. UX bridge until deeper fix lands.

## Critical Files

- `packages/opencode/src/session/user-message-persist.ts` — add reclaim helper + wire into `persistUserMessage`.
- `packages/opencode/src/session/rebind-epoch.ts` — add `everBumped` Set + unexpected-reset emit.
- `packages/opencode/src/system/runtime-event-service.ts` — no code change; new `eventType` strings reach it via existing API.
- (tests) `packages/opencode/src/session/user-message-persist.orphan-reclaim.test.ts`, `packages/opencode/src/session/rebind-epoch.unexpected-reset.test.ts`.

## Architecture

Two surgical patches, no new modules:

```
[A] persistUserMessage (session/user-message-persist.ts)
       │
       ├─ NEW: reclaimOrphanAssistant({ sessionID, beforeCreatedAt })
       │       ├─ scan most-recent assistant msg via MessageV2.stream
       │       ├─ if role=assistant && time.completed===undefined
       │       │  && (now - time.created) >= ORPHAN_RECLAIM_MIN_AGE_MS
       │       │  └─ set finish="error", time.completed=now,
       │       │     error={ name:"NamedError.Unknown", data:{ reason:"abandoned_orphan_round" } }
       │       │     via Session.updateMessage(...)
       │       │     emit RuntimeEventService.append({ workflow,
       │       │         eventType:"session.orphan_assistant_reclaimed",
       │       │         payload:{ sessionID, reclaimedMessageID, ageMs,
       │       │                   providerId, modelId, accountId, finishReason } })
       │       └─ otherwise no-op
       └─ existing Plugin.trigger + Session.updateMessage + pinExecutionIdentity + updatePart

[B] RebindEpoch.bumpEpoch (session/rebind-epoch.ts)
       │
       ├─ module-level: const everBumped = new Set<string>()
       └─ NEW: if (input.trigger==="daemon_start" && previousEpoch===0
                  && everBumped.has(input.sessionID))
              emit appendEventSafe({ anomaly,
                  eventType:"session.rebind_epoch_unexpected_reset",
                  payload:{ trigger, reason, processUptimeMs, everBumpedSize } })
           everBumped.add(input.sessionID)  // after every successful bump
```

Both patches are additive — no behaviour change for the non-anomalous path.

## Decisions

- **DD-1**: Orphan reclaim runs **inside `persistUserMessage`**, between the existing `Plugin.trigger("chat.message", ...)` and `Session.updateMessage(input.info)` calls — i.e. on the user-msg write path itself, not on a background timer. **Why**: keeps the fix synchronous with the user-visible signal ("I just typed again"); no new lifecycle / timer to reason about; deterministic in tests.
- **DD-2**: Orphan threshold is **5 seconds** since assistant `time.created`. **Why**: rounds normally produce their first stream delta well under 5s; if a row has sat for 5s with no completion AND the user is typing the next message, it's not racing a live stream. Tuneable via `ORPHAN_RECLAIM_MIN_AGE_MS` constant; not a Tweaks flag (hotfix simplicity).
- **DD-3**: Reclaim uses `Session.updateMessage(...)` (existing fn) rather than direct SQL. **Why**: preserves StorageRouter / Bus.publish / usage-delta accounting that other consumers rely on.
- **DD-4**: Emit `session.orphan_assistant_reclaimed` in domain `workflow` (not `anomaly`). **Why**: it's a recovery action, not an unexplained failure — the anomaly was the silent stream death, which we cannot detect here. The reclaim event is the recovery breadcrumb. `anomaly` domain is reserved for the rebind-reset event in [B].
- **DD-5**: `everBumped` is a **module-level `Set<string>`**, populated unconditionally on every successful bump regardless of trigger. **Why**: cheapest possible memory footprint (string per session this process has ever bumped); never cleared except by `RebindEpoch.reset()` (test-only) and `clearSession` (session.deleted bus). The `session.rebind_epoch_unexpected_reset` predicate is `trigger==="daemon_start" && everBumped.has(sid) && previousEpoch===0` — exactly the docxmcp signature.
- **DD-6**: No retry of the abandoned round. **Why**: user retype already happened (that's how this code path got invoked); auto-retry would risk double-streaming. Out of scope per proposal.
- **DD-7**: Orphan reclaim runs inline in `persistUserMessage` (not on a timer). Why: keeps fix synchronous with the user-visible signal ("I just typed again"); no new lifecycle.

## Code anchors

(will be appended via `spec_add_code_anchor` after implementation)
- `packages/opencode/src/session/user-message-persist.ts` — `reclaimOrphanAssistant` — Orphan reclaim helper — scans latest MessageV2.stream, finalizes stalled assistant row (age>=5000ms), emits session.orphan_assistant_reclaimed workflow event.
- `packages/opencode/src/session/rebind-epoch.ts` — `bumpEpoch` — Unexpected-reset detection — when trigger='daemon_start' AND everBumped.has(sid) AND registry entry was missing, emits session.rebind_epoch_unexpected_reset anomaly; bump itself unchanged.

## Submodule pinned commits

(none — pure in-repo change)
