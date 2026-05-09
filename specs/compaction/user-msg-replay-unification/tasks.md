# Tasks: user-msg-replay-unification

> Implementation checklist mirroring the IDEF0 hierarchy. Numbering follows `M<phase>-<idef0-id>-<step>`. All tasks are tracked under feature branch (per beta-workflow §7) — final fetch-back to `main` happens at verified state.

## M1 — Helper extraction (corresponds to IDEF0 A1 + A3)

- [x] M1-A1-1 Implement `snapshotUnansweredUserMessage(sessionID): Promise<{info, parts, emptyAssistantID?} | undefined>` inside `compaction.ts`. Walks `Session.messages` backward; identifies most-recent user msg whose nearest assistant child has `finish ∉ {stop, tool-calls, length}` (or no assistant child at all).
- [x] M1-A1-2 Add unit tests `compaction-snapshot.test.ts` covering: (a) clean session no unanswered → undefined; (b) unanswered with empty-finish assistant child → returns with `emptyAssistantID`; (c) unanswered with no child → returns without `emptyAssistantID`; (d) subagent session.
- [x] M1-A3-1 Implement `SessionCompaction.replayUnansweredUserMessage(input): Promise<ReplayResult>` per `data-schema.json`. Behaviour follows `design.md` DD-2 steps 1-9.
- [x] M1-A3-2 Wire `__test__.setReplayHelper` / `__test__.resetReplayHelper` exports for test mocking.
- [x] M1-A3-3 Add unit tests `compaction-replay-helper.test.ts` covering ReplayResult outcomes: replayed | already-after-anchor | no-unanswered | snapshot-already-consumed | feature-flag-disabled | exception.

## M2 — Caller integration (corresponds to IDEF0 A2 caller wiring)

- [x] M2-A2-1 Modify `defaultWriteAnchor` (compaction.ts:1911) to: snapshot via M1-A1-1 BEFORE `compactWithSharedContext`, replay via M1-A3-1 AFTER. Both gated by `Tweaks.compactionSync().enableUserMsgReplay`.
- [x] M2-A2-2 Modify `tryLlmAgent` (compaction.ts:1380-1400) to invoke replay helper after its inline `compaction` part write.
- [x] M2-A2-3 Modify provider-switch pre-loop in `prompt.ts:1099-1146`: snapshot before `SessionCompaction.compactWithSharedContext`, replay after. Helper invocation uses `observed: "provider-switched"`.
- [x] M2-A2-4 Delete inline replay block at `prompt.ts:1484-1554` (5/5 hotfix). Empty-response self-heal now relies on the helper firing automatically inside `SessionCompaction.run`.

## M3 — INJECT_CONTINUE replacement (corresponds to IDEF0 A4)

- [x] M3-A4-1 Rewrite `injectContinueAfterAnchor` (compaction.ts:1867) to a stream-driven runtime decision: read post-anchor messages, count user msgs after the latest anchor, inject Continue only if zero.
- [x] M3-A4-2 Delete static `INJECT_CONTINUE` table (compaction.ts:872-885). If `enableUserMsgReplay === false`, restore a fallback static table with the original values (mirrors pre-fix behaviour).
- [x] M3-A4-3 Update `compactWithSharedContext` auto-mode branch (compaction.ts:601) to call the same runtime-decision helper.
- [x] M3-A4-4 Update `__test__.INJECT_CONTINUE` export — keep symbol but back it with the fallback table to preserve existing test compatibility.

## M4 — Telemetry + cosmetic side-fix (corresponds to IDEF0 A5)

- [x] M4-A5-1 Add `compaction.user_msg_replay` event surface to `compaction-telemetry.ts`. Schema per `data-schema.json` ReplayTelemetryEvent.
- [x] M4-A5-2 Wire helper to emit on every invocation (success / skip / error).
- [x] M4-A5-3 Add `compaction-replay` variant to `RecentEvent` union in `recentEvents` schema. Append entry from helper with `outcome` + `observed`.
- [x] M4-A5-4 Thread `observed` argument through `compactWithSharedContext` signature — default `"unknown"`; existing callers pass real value. Update internal `publishCompactedAndResetChain(input.sessionID)` call (compaction.ts:599) to pass `{ observed: input.observed ?? "unknown", kind: "narrative" }` (kind defaults narrative since shared-context path commits narrative-style anchor).
- [x] M4-A5-5 Thread `observed` through `runLlmCompact` (compaction.ts:2761) finally-block by capturing `RunInput.observed` in the outer scope.
- [x] M4-A5-6 Verify in test that `recentEvents.compaction.observed === "unknown"` no longer appears after a synthetic session exercising every observed value.

## M5 — Tweaks + feature flag

- [x] M5-1 Register `compaction.enable_user_msg_replay` in `tweaks.cfg` KNOWN_KEYS.
- [x] M5-2 Add `enableUserMsgReplay: boolean` to `compactionSync()` Tweaks return shape; default `true`.
- [x] M5-3 Document the flag in `tweaks.cfg` comments + cross-reference from AGENTS.md if the project has a tweak inventory there.

## M6 — Integration tests (one per call site)

- [x] M6-1 `compaction-replay.empty-response.test.ts` — emulates 5/5 scenario; verifies user msg replayed; original deleted; empty assistant child deleted; telemetry `outcome: "replayed"`.
- [x] M6-2 `compaction-replay.overflow.test.ts` — state-driven overflow; verifies replay; runloop sees `lastUser` post-anchor.
- [x] M6-3 `compaction-replay.rebind.test.ts` — reproduces 2026-05-09 incident; verifies `loop:no_user_after_compaction` does NOT fire.
- [x] M6-4 `compaction-replay.provider-switch.test.ts` — provider-switch pre-loop calls compactWithSharedContext directly; verifies replay still wires.
- [x] M6-5 `compaction-replay.idempotency.test.ts` — calling helper twice with same snapshot returns `snapshot-already-consumed` second time, no duplicate.
- [x] M6-6 `compaction-replay.no-unanswered.test.ts` — clean session + manual /compact (no question pending); verifies no replay attempt.
- [x] M6-7 `compaction-replay.already-after-anchor.test.ts` — race: user adds new msg AFTER anchor write but before replay check; verifies skip with reason.
- [x] M6-8 `compaction-replay.subagent.test.ts` — `session.parentID !== undefined`; verifies helper does not refuse subagent contexts.

## M7 — Validation evidence

- [x] M7-1 Run full compaction test suite: `bun test packages/opencode/src/session/compaction*.test.ts` — all green.
- [x] M7-2 Run `bun test packages/opencode/src/session/prompt*.test.ts` — all green (catches deleted inline replay regressions).
- [x] M7-3 Manual reproduction: synthesize a session with bloated context, trigger rebind compaction, verify next iter answers user's actual question instead of generic Continue follow-up.
- [x] M7-4 Manual: trigger `/compact` after clean assistant turn — verify no double-Continue, no stale "compact request hidden behind anchor" symptom.
- [x] M7-5 Telemetry check: tail debug.log during M7-3, confirm `compaction.user_msg_replay outcome: replayed` line emitted.
- [x] M7-6 `recentEvents` check: query session API or look at Q card, confirm `observed` is the real value (rebind / overflow / etc) not "unknown".

## M8 — Spec sync to verified

- [x] M8-1 Run `bun ~/.claude/skills/plan-builder/scripts/plan-promote.ts specs/compaction/user-msg-replay-unification --to verified --reason "..."` after M7 evidence collected.
- [x] M8-2 Update `specs/compaction/README.md` Sub-packages section: change `(proposed, 2026-05-09)` to `(verified, <commit>)`.
- [x] M8-3 Update `specs/architecture.md` if compaction section names this fix.
- [x] M8-4 Final fetch-back to main per beta-workflow §7.

## Out-of-band (no checklist; tracked but not gating)

- Sibling spec `compaction/narrative-quality` resumes after this lands. Update `narrative-quality/proposal.md` Cross-spec coupling section to reflect dependency satisfied.
- Memory entry [project_compaction_replay_three_siblings_2026_05_09.md](https://example/) cross-link from `MEMORY.md` continues to point here; update on archive.
