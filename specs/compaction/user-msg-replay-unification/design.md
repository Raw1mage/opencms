# Design: user-msg-replay-unification

## Context

The defect is a missing post-condition on `SessionCompaction` commit paths: **if an unanswered user message existed pre-compaction, an unanswered user message must exist post-compaction with id > anchor.id**. Today only one of four compaction call sites enforces this post-condition (the 5/5 hotfix at `prompt.ts:1484-1554`); the other three rely on `INJECT_CONTINUE` substituting a synthetic Continue, which (a) is `false` for several observed values and (b) discards the user's actual question even when `true`.

Production debug.log evidence on session `ses_1f47aa711ffehMSKNf54ZCHFTF` (2026-05-09 15:44) confirms the same swallow-bug recurred via the `rebind` pre-emptive compaction path that the 5/5 hotfix never covered. See proposal.md § Why for full timeline.

The fix moves the replay logic from a single call site to the central commit point inside `SessionCompaction`, and replaces the static `INJECT_CONTINUE` table with a runtime decision based on whether an unanswered user message already exists in the post-compaction stream.

## Goals / Non-Goals

### Goals

- Eliminate the silent-exit failure mode (`loop:no_user_after_compaction`) when an unanswered user message exists pre-compaction.
- Single source of truth: replay logic lives once inside `SessionCompaction` module, callable from every commit path.
- Future-proof: any new compaction trigger added later inherits the fix automatically without per-site code.
- Loud telemetry: previously-silent failures emit `compaction.user_msg_replay` events for diagnosability.
- Cosmetic: fix `recentEvents.compaction.observed === "unknown"` from the two bare `publishCompactedAndResetChain` call sites.

### Non-Goals

- Restructuring `SessionCompaction.run` chain semantics or kind ordering.
- Merging the `compactWithSharedContext` legacy path into `SessionCompaction.run` (DD-9 keeps separation).
- Backporting to the legacy `process()` compaction path (deprecated, retired separately).
- Improving narrative anchor body quality (handled by sibling spec `compaction/narrative-quality`).
- Changing the synthetic Continue text wording.

## Decisions

### DD-1 — Helper lives in `SessionCompaction` module, not in `prompt.ts`

The helper accesses `Session.updateMessage` / `Session.updatePart` / `Session.removeMessage` and `Identifier.ascending`. These are session-storage primitives, not runloop primitives. Locating it inside `compaction.ts` puts it next to the anchor writer (which is its only correct call site) and reuses the existing `__test__.setAnchorWriter` test seam.

**Why**: prevents future "I added a new compaction trigger in prompt.ts and forgot to call the helper" regression. The runloop never calls the helper directly — it calls `SessionCompaction.run` (or `compactWithSharedContext` for the legacy path), and the helper fires from inside as part of the commit transaction.

### DD-2 — Helper signature

```ts
namespace SessionCompaction {
  export async function replayUnansweredUserMessage(input: {
    sessionID: string
    /** Snapshot of (lastUser msg + parts) taken BEFORE compaction.run was called. */
    snapshot: {
      info: MessageV2.User
      parts: MessageV2.Part[]
    }
    /** id of the just-written anchor msg. Replayed user msg id must be > this. */
    anchorMessageID: string
    /** Optional: if a known empty-assistant child message exists (5/5 case),
        delete it together with the original user msg to keep UI clean. */
    emptyAssistantID?: string
    /** Caller context, threaded into log entries for diagnosability. */
    observed: Observed
    step: number
  }): Promise<{ replayed: boolean; newUserID?: string; reason?: string }>
}
```

**Behaviour**:

1. Read current messages stream. Find the most-recent anchor (`summary: true && time.created >= anchorMessageID-bound`).
2. If `snapshot.info.id > anchorMessageID` (i.e. user msg is already after anchor — happens when caller raced or when user msg was added between anchor write and helper call), do nothing; return `{ replayed: false, reason: "already-after-anchor" }`.
3. If `snapshot.info.id < anchorMessageID` (the bug case), generate `newUserID = Identifier.ascending("message")`. Asserting it's > anchorMessageID is a property of monotone ULIDs.
4. Write new user message with `{ ...snapshot.info, id: newUserID, time: { created: Date.now() } }`.
5. For each part in `snapshot.parts`: write with `{ ...part, id: Identifier.ascending("part"), messageID: newUserID }`.
6. If `emptyAssistantID` provided, `Session.removeMessage` it.
7. `Session.removeMessage` the original `snapshot.info.id`.
8. Return `{ replayed: true, newUserID }`.
9. On any error, log to `log.error` with `{ sessionID, step, observed, originalUserID, anchorMessageID, error }` and return `{ replayed: false, reason: "exception" }` — caller decides how to recover. Caller of replay never throws.

### DD-3 — Caller call sites

**Three sites must invoke the helper**:

| Site | Line | When |
|------|------|------|
| `defaultWriteAnchor` | `compaction.ts:1911` | After `compactWithSharedContext` returns successfully |
| `tryLlmAgent` (Phase 7b) | `compaction.ts:1380-1400` | After the inline anchor write (`Session.updatePart` for `compaction` part type) |
| `compactWithSharedContext` direct caller | `prompt.ts:1099-1146` (provider-switch pre-loop) | After `SessionCompaction.compactWithSharedContext` returns |

**Order of operations inside `defaultWriteAnchor` (DD-1 caller flow)**:

```
defaultWriteAnchor(input):
  prevAnchorId = readMostRecentAnchorId(sessionID)
  
  // NEW: snapshot unanswered user msg BEFORE compactWithSharedContext writes anchor
  unanswered = await snapshotUnansweredUserMessage(sessionID)
  
  await compactWithSharedContext({
    sessionID, snapshot: sanitized.body, model, auto: <decided by caller>,
  })
  
  newAnchorId = readMostRecentAnchorId(sessionID)
  
  // NEW: replay user msg if buried
  if (unanswered && newAnchorId) {
    replayUnansweredUserMessage({
      sessionID,
      snapshot: unanswered,
      anchorMessageID: newAnchorId,
      observed: input.observed,
      step: input.step,
    })
  }
  
  await annotateAnchorWithSkillState(...)
```

`snapshotUnansweredUserMessage` is a small local helper that:
- Loads `Session.messages(sessionID)`
- Walks backward from the tail
- Finds the most-recent user message
- If that user msg is followed by an assistant message with `finish === "stop" / "tool-calls" / "length"` → treat as ANSWERED → return undefined
- If it's followed by no assistant or by an empty-finish assistant (`unknown` / `error` / `other`) → treat as UNANSWERED → return `{ info, parts, emptyAssistantID? }`
- If no user message exists → return undefined

This is what determines "unanswered" — pure stream inspection, no flag passing.

### DD-4 — `INJECT_CONTINUE` table is replaced

Today (`compaction.ts:872-885`):

```ts
const INJECT_CONTINUE: Readonly<Record<Observed, boolean>> = Object.freeze({
  overflow: true, "cache-aware": true, idle: true,
  rebind: false, "continuation-invalidated": false, "provider-switched": false,
  "stall-recovery": false, manual: false, "empty-response": true,
})
```

Replaced by a runtime check inside `SessionCompaction.run` (and `injectContinueAfterAnchor`):

```
After the helper has run:
  - If replayed: do NOT inject Continue (the real user msg drives the loop)
  - If not replayed AND no user msg exists post-anchor: INJECT Continue (preserves
    today's auto-mode behaviour for the cases where the user wasn't expecting a reply)
  - If not replayed AND a user msg already exists post-anchor: skip Continue (e.g. the
    /compact manual command — user message is the trigger)
```

This makes `INJECT_CONTINUE` table-free. Behaviour parity table:

| observed | Old INJECT_CONTINUE | New runtime decision (typical) |
|----------|---------------------|-------------------------------|
| `overflow` | true | replay user msg (no Continue) |
| `cache-aware` | true | replay user msg (no Continue) |
| `idle` | true | no user msg exists → inject Continue (unchanged) |
| `rebind` | false | replay user msg (was: silent exit) |
| `continuation-invalidated` | false | replay user msg (was: silent exit) |
| `provider-switched` | false | replay user msg (was: silent exit) |
| `stall-recovery` | false | replay if exists, else nothing (typical: no user msg, runloop stays quiet) |
| `manual` | false | post-anchor user msg already exists (the `/compact` request itself) → skip |
| `empty-response` | true | replay user msg (matches 5/5 hotfix) |

### DD-5 — Cosmetic side-fix: `recentEvents` "unknown" observed

Two sites currently call `publishCompactedAndResetChain(sessionID)` without `eventMeta`, causing the per-session `recentEvents` ring buffer to record `observed: "unknown"`:

- `compactWithSharedContext`, `compaction.ts:599`
- `runLlmCompact`, `compaction.ts:2761`

Both have caller context that knows the observed value. Threading it through:

- `compactWithSharedContext` gets a new optional `observed?: Observed` argument; existing callers pass it (default: `"unknown"` if caller is non-compaction code paths, e.g. provider-switch which knows `"provider-switched"`).
- `runLlmCompact`'s `runLlmCompactInner` already knows the observed value via `RunInput.observed` — thread to the `finally` block.

Both call sites pass `{ observed, kind }` to `publishCompactedAndResetChain`.

### DD-6 — Telemetry

New event channel: `compaction.telemetry surface=user_msg_replay`. Fields:

```
{
  sessionID,
  step,
  observed,
  originalUserID,
  newUserID,
  anchorMessageID,
  anchorObserved,    // observed value at anchor write
  hadEmptyAssistantChild: boolean,
  partCount: number,
  outcome: "replayed" | "skipped:already-after-anchor" | "skipped:no-unanswered" | "error",
  errorMessage?: string,
}
```

Routed via existing `compaction-telemetry.ts` `emit*` helpers. Surfaces in:
- `bus.session.telemetry.updated` so frontend Q card can render the event
- `recentEvents` ring buffer so it shows up in `bus.session.updated` `execution.recentEvents`

This converts the previously-silent failure mode into a loud diagnostic signal.

### DD-7 — Test seam and coverage

`SessionCompaction.__test__` namespace already exposes `setAnchorWriter`, `KIND_CHAIN`, `INJECT_CONTINUE`. Add:

```
__test__.setReplayHelper(fn)   — substitute the helper for unit tests
__test__.resetReplayHelper()
```

**Test fixtures** (one per call site, plus property tests):

1. `compaction-replay.empty-response.test.ts` — emulates the 5/5 scenario: `prompt.ts:1484` self-heal triggers, helper replays, original user msg + empty assistant deleted.
2. `compaction-replay.overflow.test.ts` — pre-loop overflow predicate fires `SessionCompaction.run({ observed: "overflow" })`, helper replays.
3. `compaction-replay.rebind.test.ts` — rebind pre-emptive at `prompt.ts:2114` fires, helper replays. Reproduces the 2026-05-09 incident.
4. `compaction-replay.provider-switch.test.ts` — provider-switch pre-loop at `prompt.ts:1099-1146` fires, helper replays through `compactWithSharedContext` legacy path.
5. `compaction-replay.idempotency.test.ts` — calling helper twice in a row (e.g. retry storm) does not duplicate.
6. `compaction-replay.no-unanswered.test.ts` — manual `/compact` after model finished cleanly: helper detects no unanswered msg and skips.
7. `compaction-replay.already-after-anchor.test.ts` — race case where user msg id > anchor id: helper skips with reason.
8. `compaction-replay.subagent.test.ts` — subagent session (parentID set): replay still works (subagents don't auto-compact, but if a manual compaction happens, behaviour must be correct).

Tests use `MockSession` storage (in-memory), `setAnchorWriter` to capture the synthetic anchor, no real Bus / Provider.

### DD-8 — Failure mode and rollback

Helper failures are non-fatal:
- Logged to `log.error` with full diagnostic context
- Telemetry event emitted with `outcome: "error"`
- Caller's runloop continues (does not throw)
- Symptom degrades to today's behaviour: user msg may be hidden behind anchor → `loop:no_user_after_compaction` exits

This is the **same** failure-mode floor we have today, so the helper can ONLY improve things — never regress.

**Rollback**: revert via feature flag `Tweaks.compactionSync().enableUserMsgReplay` (default `true`). When `false`, all three call sites skip the helper invocation; `INJECT_CONTINUE` table reads from a fallback constant. One-line revert at any time.

### DD-9 — `compactWithSharedContext` legacy path remains

The provider-switch pre-loop at `prompt.ts:1099-1146` calls `compactWithSharedContext` directly, bypassing `SessionCompaction.run`. This is by design — see the comments in that block: `LLM compaction is NOT safe because old provider's tool call history is incompatible.` The fix does NOT merge that path into `run`; instead, it adds the helper invocation directly after `compactWithSharedContext` returns. The legacy path keeps its skip-the-chain semantics.

This is the smallest viable refactor: 4 lines added at `prompt.ts:1145` (snapshot before, replay after).

## Risks / Trade-offs

### Risks

- **Concurrent runloop race**: replaying a user msg with a new ULID could collide with concurrent stream writes if the runloop is unsafely re-entered. Mitigated by the existing single-runloop-per-session invariant (`SessionPrompt.runLoop` is gated by per-session locking). No new locking introduced.
- **Storage write amplification**: each replay = 1 user msg write + N part writes + 1-2 deletes. For a typical user turn (~3 parts) this is ~5-6 SQLite writes, sub-millisecond. Acceptable.
- **Telemetry noise**: emitting `compaction.user_msg_replay` on every replay adds a row to `recentEvents` ring buffer per compaction. Bounded by ring buffer capacity; ignorable.
- **Helper exception swallowing**: per DD-2 #9, helper errors are logged but never thrown — keeps the runloop alive but could mask a hard storage failure. Mitigated by `log.error` + telemetry `outcome: "error"`; operators can still detect via debug.log + Q card.
- **Feature flag misuse**: setting `Tweaks.compactionSync().enableUserMsgReplay = false` re-introduces the bug. Documented in `tweaks.cfg` comments + AGENTS.md cross-reference.

### Trade-offs

- **Helper inside `SessionCompaction` vs `prompt.ts`**: chose `SessionCompaction` (DD-1) — gains test seam and central enforcement; loses the option of bypass at the runloop layer (we don't need bypass).
- **Stream-driven Continue decision vs typed enum**: chose runtime check (DD-4) over per-`observed` flag table — gains correctness across new observed values added in the future; loses the immediately-readable static table. Mitigated by a comment block at `injectContinueAfterAnchor` documenting the runtime semantics.
- **Two bare call sites still in `compactWithSharedContext`**: chose to thread `observed` argument through (DD-5) rather than introduce a new helper — minimal API surface change.
- **Subagent path NOT excluded**: helper runs for subagents too (DD-7 test #8). Subagents historically don't auto-compact, but if they do (manual / future feature), the replay still works correctly.

## Critical Files

- [packages/opencode/src/session/compaction.ts](packages/opencode/src/session/compaction.ts) — primary edit target: new helper export, `defaultWriteAnchor` modification (DD-3), `injectContinueAfterAnchor` rewrite (DD-4), `INJECT_CONTINUE` table deletion, two bare-call-site `eventMeta` fixes (DD-5).
- [packages/opencode/src/session/prompt.ts](packages/opencode/src/session/prompt.ts) — secondary edit: delete inline 5/5 hotfix at lines 1484-1554, add helper invocation at provider-switch path lines 1099-1146.
- [packages/opencode/src/session/compaction-run.test.ts](packages/opencode/src/session/compaction-run.test.ts) — existing test seam reference (`__test__.setAnchorWriter` pattern).
- [packages/opencode/src/session/tweaks.ts](packages/opencode/src/session/tweaks.ts) — register new `enableUserMsgReplay` key + default `true`.
- New test files (under `packages/opencode/src/session/`): `compaction-replay.empty-response.test.ts`, `compaction-replay.overflow.test.ts`, `compaction-replay.rebind.test.ts`, `compaction-replay.provider-switch.test.ts`, `compaction-replay.idempotency.test.ts`, `compaction-replay.no-unanswered.test.ts`, `compaction-replay.already-after-anchor.test.ts`, `compaction-replay.subagent.test.ts`.

## Code anchors

- [packages/opencode/src/session/compaction.ts:512](packages/opencode/src/session/compaction.ts#L512) — `compactWithSharedContext` (legacy path)
- [packages/opencode/src/session/compaction.ts:599](packages/opencode/src/session/compaction.ts#L599) — bare `publishCompactedAndResetChain` call (DD-5 fix)
- [packages/opencode/src/session/compaction.ts:872-885](packages/opencode/src/session/compaction.ts#L872-L885) — `INJECT_CONTINUE` table (DD-4 replaces)
- [packages/opencode/src/session/compaction.ts:1380-1400](packages/opencode/src/session/compaction.ts#L1380-L1400) — `tryLlmAgent` inline anchor write (DD-3 caller)
- [packages/opencode/src/session/compaction.ts:1700](packages/opencode/src/session/compaction.ts#L1700) — `SessionCompaction.run` entry
- [packages/opencode/src/session/compaction.ts:1700-1859](packages/opencode/src/session/compaction.ts#L1700-L1859) — `run()` chain walker (DD-3 caller via `defaultWriteAnchor`)
- [packages/opencode/src/session/compaction.ts:1867-1893](packages/opencode/src/session/compaction.ts#L1867-L1893) — `injectContinueAfterAnchor` (DD-4 modifies)
- [packages/opencode/src/session/compaction.ts:1911-1948](packages/opencode/src/session/compaction.ts#L1911-L1948) — `defaultWriteAnchor` (DD-3 primary call site)
- [packages/opencode/src/session/compaction.ts:2761](packages/opencode/src/session/compaction.ts#L2761) — bare `publishCompactedAndResetChain` in `runLlmCompact` (DD-5 fix)
- [packages/opencode/src/session/prompt.ts:1099-1146](packages/opencode/src/session/prompt.ts#L1099-L1146) — provider-switch pre-loop (DD-3 caller, DD-9)
- [packages/opencode/src/session/prompt.ts:1240-1250](packages/opencode/src/session/prompt.ts#L1240-L1250) — `loop:no_user_after_compaction` exit (becomes diagnostic-only)
- [packages/opencode/src/session/prompt.ts:1484-1554](packages/opencode/src/session/prompt.ts#L1484-L1554) — 5/5 hotfix inline replay (DD-3 deletes, helper takes over)
- [packages/opencode/src/session/prompt.ts:2104-2130](packages/opencode/src/session/prompt.ts#L2104-L2130) — rebind pre-emptive (call to `SessionCompaction.run`; helper auto-fires inside)
- [packages/opencode/src/session/prompt.ts:2387-2412](packages/opencode/src/session/prompt.ts#L2387-L2412) — state-driven overflow (call to `SessionCompaction.run`; helper auto-fires inside)
- [packages/opencode/src/session/compaction-run.test.ts:1-20](packages/opencode/src/session/compaction-run.test.ts#L1-L20) — existing test seam pattern (`__test__.setAnchorWriter` etc.)

## Submodule references

None.

## Related specs

- `compaction/empty-turn-recovery` — owns the `empty-response` observed condition; the 5/5 hotfix lived in its self-heal path.
- `compaction/itemcount-fix` — owns post-anchor item-count discipline; fix here does not affect post-anchor item count, only message presence.
- `compaction/working-cache` — independent; no overlap.
- `compaction/narrative-quality` — depends on this spec landing first (so the silent-exit symptom doesn't mask narrative-quality investigations).
- `session/` — runloop owns the call-site scaffolding; this spec edits 4 lines in `prompt.ts`.

## Open questions

None blocking. Resolved during proposal phase via `feedback_minimal_fix_then_stop.md` (smallest patch first), `feedback_no_silent_fallback.md` (helper logs all branches), and the explicit user approval of semi-framework approach over per-site patches.
