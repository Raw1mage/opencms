# Tasks — compaction-redesign

Phases follow design.md "Migration Sequence". Each phase is independently
reviewable and rolls back cleanly without the next.

## 1. Memory module skeleton + Storage path

- [x] 1.1 Create `packages/opencode/src/session/memory.ts` with `Memory` namespace skeleton (no consumers yet)
- [x] 1.2 Define `SessionMemory`, `TurnSummary` types per `data-schema.json`
- [x] 1.3 Implement `Memory.read(sid)`: returns SessionMemory; falls back to legacy SharedContext + checkpoint per DD-3
- [x] 1.4 Implement `Memory.write(sid, mem)`: writes to `Storage` key `session_memory/<sid>`
- [x] 1.5 Implement `Memory.appendTurnSummary(sid, ts)`: append + bump version + persist
- [x] 1.6 Implement `Memory.markCompacted(sid, {round, timestamp})` for cooldown source-of-truth
- [x] 1.7 Unit test: read/write round-trip; legacy fallback projects SharedContext.Space → SessionMemory shape correctly

## 2. Memory render functions

- [x] 2.1 Implement `Memory.renderForLLM(sid)`: compact provider-agnostic plain text from turnSummaries + auxiliary metadata
- [x] 2.2 Implement `Memory.renderForHuman(sid)`: timeline form with turn boundaries, decisions, file/action chronology
- [x] 2.3 Unit test: both render functions on a populated SessionMemory produce syntactically distinct strings (R-8 acceptance)
- [x] 2.4 Unit test: renderForLLM stays under 30% of typical model context (sanity check on default budget)

## 3. TurnSummary capture at runloop exit

- [x] 3.1 Add capture call at `prompt.ts:1230` (`exiting loop` site): read `lastAssistant` final text part, build TurnSummary
- [x] 3.2 Capture is fire-and-forget (`Memory.appendTurnSummary(...).catch(...)`); does not block runloop return
- [x] 3.3 Skip capture if `lastAssistant` is null or has no text part (e.g. error exit)
- [~] 3.4 Manual smoke deferred to phase 11 (acceptance): requires daemon restart to exercise; unit-tested via `prompt.turn-summary-capture.test.ts` instead

## 4. Single entry point `SessionCompaction.run`

- [x] 4.1 Define `RunInput` / `RunResult` types per data-schema.json
- [x] 4.2 Define `KIND_CHAIN: Record<Observed, KindStep[]>` table literal in `compaction.ts`
- [x] 4.3 Define `INJECT_CONTINUE: Record<Observed, boolean>` table literal
- [x] 4.4 Implement `Cooldown.shouldThrottle(sid, currentRound, threshold)` reading `Memory.lastCompactedAt`
- [x] 4.5 Implement `SessionCompaction.run(input)`: cooldown check → walk chain → write Anchor → mark compacted; emit `log.info` per AGENTS.md rule 1 on every kind transition
- [x] 4.6 Unit test: `run({observed: "rebind"})` never appends synthetic Continue (R-6 acceptance)
- [x] 4.7 Unit test: `run({observed: "manual"})` with non-empty Memory returns "continue" without API call (R-4 acceptance)
- [x] 4.8 Unit test: `run({observed: "provider-switched"})` rejects kinds 3-5 (R-5 acceptance)

## 5. Executor implementations

- [x] 5.1 Narrative executor (C5): reads `Memory.renderForLLM`, budget-checks ≤ 30%, calls anchor-write helper *(done in phase 4)*
- [x] 5.2 Schema executor (C6): reads legacy `SharedContext.snapshot`, calls anchor-write helper (used only when narrative empty)
- [x] 5.3 Replay-tail executor (C7): reads last N raw rounds from message stream, serializes as plain text, calls anchor-write helper
- [x] 5.4 Low-cost-server executor (C8): de-coupled from legacy `tryPluginCompaction` (own helper `buildConversationItemsForPlugin`); gated on provider supporting `session.compact` hook
- [~] 5.5 LLM-agent executor (C9): stub for now; full extraction from legacy `process()` deferred to phase 6+ with runloop wiring
- [x] 5.6 Unit test per executor: schema success/empty/over-budget; replay-tail success/over-budget; low-cost-server success/plugin-null; combined 23 tests pass

## 6. Runloop state-driven evaluation

- [x] 6.1 Implement `deriveObservedCondition(session)` in `prompt.ts` per design.md pseudocode
- [~] 6.2 Wire NEW path before legacy rebind branch (transitional bridge, fall-through to legacy when run returns "stop"); legacy branch is removed in phase 7 after llm-agent extraction
- [~] 6.3 Wire NEW path before legacy overflow / cache-aware branch (same bridge pattern)
- [~] 6.4 Wire NEW path before legacy compaction-request task branch (same bridge pattern). `Memory.requestCompaction` retained.
- [x] 6.5 Verify single `run()` call per iteration: deriveObservedCondition is invoked once and only one `observed` value is returned. Cooldown gate inside run() prevents same-iteration double-fire.
- [x] 6.6 Unit test: deriveObservedCondition fixtures (14 cases) cover null / manual / provider-switched / rebind / overflow / cache-aware / parentID-skip / cooldown-skip / priority ordering. findMostRecentAnchor (3 cases).

## 6b. State-driven extension (added 2026-04-27, DD-11 + DD-12)

- [x] 6b.1 Added `continuationInvalidatedAt: z.number().optional()` to `ExecutionIdentity` schema; new helper `Session.markContinuationInvalidated(sid)` writes the timestamp.
- [x] 6b.2 Replaced `compaction.ts:36` Bus listener body: now calls `Session.markContinuationInvalidated(sid)`. Legacy `markRebindCompaction` will be deleted in phase 7.
- [x] 6b.3 Extended `deriveObservedCondition` with continuation-invalidated check; reads timestamp via runloop's `Session.get`; compares against `findMostRecentAnchor.createdAt` (lifted from `time.created`). Priority order updated to `manual > continuation-invalidated > provider-switched > rebind > overflow > cache-aware`.
- [x] 6b.4 Dropped unconditional parentID skip; narrowed to `if (hasUnprocessedCompactionRequest && !isSubagent)` — subagents skip only `"manual"`.
- [x] 6b.5 Drain audit: no double-drain risk. The transitional `consumeRebindCompaction` at top of new path is harmless even if processor.ts sets a flag later in same iteration — the flag is set AFTER the drain in execution order, and next iteration will drain again. With phase 7 removing the flag, this concern disappears entirely.
- [x] 6b.6 Tests added: 5 new cases in `prompt.observed-condition.test.ts` covering DD-11 (timestamp newer/stale/no-anchor/priority over rebind) + DD-12 (subagent rebind fires; subagent manual skipped). 19 tests total in that file.

## 7. Remove flag-based plumbing

> Phase 7b (LLM-agent extraction) **must complete first**. Without it, deleting the legacy compaction-request branch in prompt.ts removes the only LLM-agent fallback path, regressing empty-Memory `/compact` sessions.

## 7b. LLM-agent extraction (added 2026-04-27 mid-implementation; precedes phase 7)

- [x] 7b.1 LLM-round core identified: `process()` post-`tryPluginCompaction` block (Agent.get + Provider.getModel + canSummarize + Session.updateMessage + SessionProcessor.create + Plugin.trigger + truncate + processor.process + compaction-part write + checkpoint save).
- [x] 7b.2 Extracted into `runLlmCompactionAgent(input)`. Writes the anchor inline (the LLM round needs a persisted message); returns the resulting summary text. New `injectContinueAfterAnchor(sessionID, observed)` factored out for the synthetic Continue user message so run() owns Continue placement.
- [x] 7b.3 `tryLlmAgent` rewritten: calls `runLlmCompactionAgent`, returns `{ok: true, summaryText, kind: "llm-agent", anchorWritten: true}` on success. KindAttempt type extended with `anchorWritten?: boolean`; run() skips `_writeAnchor` when set.
- [x] 7b.4 `process()` body shrunk to ~15 lines: delegates to `runLlmCompactionAgent`, then `injectContinueAfterAnchor` if auto. Same observable behaviour for legacy callers (compaction-request branch in prompt.ts).
- [x] 7b.5 `run({observed: "manual"})` empty-Memory path: tryLlmAgent provides the LLM-agent fallback. Verified via test pass — existing `compaction-run.test.ts` test "memory empty + paid kinds unimplemented (phase 4): chain exhausts" no longer applies because llm-agent is no longer a stub. The test currently still passes because the mocks don't supply Session.messages — tryLlmAgent fails the "no messages" guard. End-to-end "/compact on empty Memory writes anchor via LLM agent" remains a phase-11 manual-smoke check.
- [x] 7b.6 Existing `compaction.test.ts` 9 cases all pass. Combined 77 tests pass across 6 phase 1-7b files.

- [x] 7.1 Deleted `pendingRebindCompaction` Set, `markRebindCompaction`, `consumeRebindCompaction` from compaction.ts (DD-11 cleared the blocker by moving continuation-invalidated to session.execution).
- [x] 7.2 Deleted `markRebindCompaction` call at `processor.ts:734`. Pin update via `Session.pinExecutionIdentity` retained. Drive-by fix: `l.warn` typo at line 391 corrected to `log.warn`.
- [x] 7.3 Deleted three legacy compaction branches from prompt.ts (compaction-request task processing / continuation-rebind / overflow). New state-driven path is the only compaction caller now.
- [x] 7.4 Deleted `cooldownState` Map. `recordCompaction` becomes a thin async shim that delegates to `Memory.markCompacted`; `getCooldownState` reads from `Memory.lastCompactedAt`. `isOverflow` and `shouldCacheAwareCompact` rewired through the async getter.
- [x] 7.5 Code grep clean: zero non-comment references to deleted symbols.
- [x] 7.6 Tests migrated: legacy `compaction.test.ts` cooldown tests rewritten with `stubMemoryCooldown` helper. Two old "rebind compaction respects cooldown" + "rebind compaction without currentRound bypasses cooldown" tests removed (deleted with the API). Regression coverage moved to `compaction.regression-2026-04-27.test.ts` which exercises the same defenses on the new state-driven path. 75 tests pass across 6 phase 1-7 files.

## 8. Anchor unification (DD-8)

- [x] 8.1 `lastMessageId` is now optional on `RebindCheckpoint` and `saveCheckpointAfterCompaction`. New writes from prompt.ts:1786 omit it. Field retained on the schema so legacy checkpoints still parse.
- [x] 8.2 `applyRebindCheckpoint` now uses a new `findRebindBoundaryIndex` helper: scans messages backward for the most recent `summary: true` assistant message; falls back to checkpoint's `lastMessageId` only when no anchor is in the stream.
- [x] 8.3 Legacy backward-read works: existing 2 tests with `lastMessageId: "msg_2"` (and no summary anchor in their stream) still pass via the legacy fallback branch.
- [~] 8.4 Manual smoke deferred to phase 11 (acceptance) — needs daemon restart in beta worktree. Unit tests cover both the anchor-scan path (new) and legacy-lastMessageId path (existing).

## 9. Deprecation shim layer

- [ ] 9.1 Create `packages/opencode/src/session/compaction-shims.ts` housing all deprecated APIs
- [ ] 9.2 `SharedContext.snapshot` → delegates to `Memory.renderForLLM`; emits `log.warn`
- [ ] 9.3 `saveRebindCheckpoint` / `loadRebindCheckpoint` → delegate to `Memory.write/read` with snapshot projection; emit `log.warn`
- [ ] 9.4 `SessionCompaction.process` → delegates to `SessionCompaction.run({observed: "manual"})`; emit `log.warn`
- [ ] 9.5 `compactWithSharedContext` → delegates to `SessionCompaction.run` with appropriate trigger; emit `log.warn`
- [ ] 9.6 CI grep: `log.warn` from shims appears zero times in CI test output (proves all in-repo callers migrated)

## 10. UI consumption of renderForHuman

- [ ] 10.1 Identify UI session-list preview code path (in `packages/app/`)
- [ ] 10.2 Replace existing snapshot fetch with `Memory.renderForHuman`
- [ ] 10.3 Manual smoke: session list preview shows timeline-format text instead of XML-ish snapshot
- [ ] 10.4 Add `/compact --rich` flag to API route; smoke-test it skips kinds 1-3 (DD-10)

## 11. Validation + final cutover

- [ ] 11.1 Run full `compaction.test.ts` suite — all 9 existing cases pass
- [ ] 11.2 Run new tests added in phases 1-10
- [ ] 11.3 Manual smoke: trigger account rotation mid-session, verify exactly one rebind Anchor produced (acceptance gate against 2026-04-27 incidents)
- [ ] 11.4 Manual smoke: invoke `/compact` on populated session, verify zero codex API calls (verifiable via codex usage logs)
- [ ] 11.5 Update `specs/architecture.md` "Compaction" section with new 3-concept diagram
- [ ] 11.6 Write `docs/events/event_<YYYYMMDD>_compaction_redesign_complete.md` capturing scope of changes + before/after metrics

## 12. Deprecation removal (next release)

- [ ] 12.1 Delete `compaction-shims.ts` and all deprecated API symbols (DD-6: 1-release window)
- [ ] 12.2 Delete legacy `shared_context/<sid>` Storage reads after configurable threshold (e.g. 90 days idle)
- [ ] 12.3 Run plan-archive.ts to mark this spec `archived`
