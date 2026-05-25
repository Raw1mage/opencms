---
date: 2026-05-25
summary: "overflow-replay-length-fix — two snapshot-helper defects causing 'AI answers one line then stops' after overflow compaction"
---

# overflow-replay-length-fix — Path A + Path B snapshot helper defects

## Symptom (user-visible)

After overflow compaction triggers, the AI replies with a single brief acknowledgement ("好，我會做 X") and stops. No tool calls, no further iteration. The original user task does not get completed.

## Two independent root causes, same symptom

The 2026-05-09 verified spec landed `snapshotUnansweredUserMessage` + `replayUnansweredUserMessage` and wired them into `SessionCompaction.run`. The post-condition "an unanswered user msg exists post-anchor with id > anchor.id" held for the test suite but failed in production for two scenarios the spec's M6 integration tests did not cover.

### Path A — proactive (pre-LLM) overflow

`deriveObservedCondition` returns `"overflow"` before the next LLM call. `SessionCompaction.run` snapshots, but the prior assistant turn's `finish === "length"` (the codex server truncated mid-stream on a prior round). The original helper:

```ts
if (finish === "stop" || finish === "tool-calls" || finish === "length") {
  return undefined
}
```

treated length as "answered" — symmetric with stop/tool-calls. For overflow specifically this is wrong: length IS the literal symptom of overflow. Snapshot returned undefined → no replay → defaultWriteAnchor's `if (input.snapshot)` guard skipped → `injectContinueAfterAnchor` posted a minimal synthetic "Continue" → AI saw [anchor summary, "Continue"] without the user's real instruction → vague reply.

### Path B — reactive (mid-LLM) overflow via SessionCompaction.create

When the LLM call itself throws `ContextOverflowError` mid-stream, `processor.ts:1703` returns `"compact"` and `prompt.ts:3204` calls `SessionCompaction.create` (NOT `.run`). `.create` writes a user-role message whose only part is `{ type: "compaction-request" }` — a placeholder, not the user's actual text. The next runloop iteration picks up the placeholder via the tasks scanner and triggers `.run`.

Inside `.run`, snapshot walks backward to find the most recent user msg → finds the **placeholder**, not the real user request → reports it as unanswered (no assistant child) → replays the placeholder post-anchor. The AI sees [anchor summary, compaction-request placeholder] — same vague reply.

## Fix

Single helper, two surgical changes:

1. **Path A** — make length-as-answered conditional on `observed`. Add `observed: Observed` parameter; treat length as unanswered when `observed === "overflow"`. All other observed values keep length-as-answered (the legitimate "user asked for a long doc, model legitimately ran to context length" case).

2. **Path B** — in the backward walk for the most recent user msg, skip messages whose every part is `compaction-request`. The skip is `continue`, not `break`, so stacked placeholders also walk past.

## Files touched

- `packages/opencode/src/session/compaction.ts` — helper signature, predicate, placeholder skip.
- `packages/opencode/src/session/compaction.ts:2426` — caller inside `SessionCompaction.run` threads observed.
- `packages/opencode/src/session/prompt.ts:1355` — provider-switched pre-loop threads `"provider-switched"`.
- `packages/opencode/src/session/compaction-replay-helpers.test.ts` — 16 existing call sites updated to pass `"manual"` (preserves prior semantics); 4 new tests for Path A, Path A complement, Path B, stacked Path B.

## Test evidence

- `compaction-replay-helpers.test.ts`: 27 pass / 0 fail (was 23 pre-change; +4 new).
- Full `src/session/compaction*.test.ts + test/session/compaction*.test.ts`: 170 pass / 28 fail vs HEAD baseline 138 pass / 28 fail. Failures are all pre-existing (verified by stash-and-rerun), not caused by this fix. The 4 new tests are the +4 delta.

## Why M6 integration tests missed both paths

- **Path A**: M6-2 `compaction-replay.overflow.test.ts` uses an in-flight user msg (no assistant child), not a user msg with a length-finished assistant child. The helper returned the snapshot via the "no assistant child" branch, never exercising the finish predicate.
- **Path B**: There is no M6 test for the `SessionCompaction.create` → next-iter `.run` handoff. The compaction-request placeholder pattern was assumed to be inert metadata, not a candidate for `snapshotUnansweredUserMessage` to confuse with the real user msg.

## Spec implication

`spec.md` Requirement 1 ("Post-anchor user-message preservation") still holds — but its underlying machinery needed two predicates the original design did not enumerate. No spec amendment needed for the verified state; this event records the gap closure. If the spec is ever revised, the new Scenario coverage to add is:
- "Mid-LLM ContextOverflowError → SessionCompaction.create placeholder → next-iter .run preserves real user intent across anchor."
- "Pre-LLM overflow with prior turn finish=length → replay still fires."

## Branch & commit

Branch: `beta/overflow-replay-length-fix`. Per beta-workflow §7 the code stays on this branch until fetch-back to `main` is requested.
