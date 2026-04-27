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

- [ ] 4.1 Define `RunInput` / `RunResult` types per data-schema.json
- [ ] 4.2 Define `KIND_CHAIN: Record<Observed, KindStep[]>` table literal in `compaction.ts`
- [ ] 4.3 Define `INJECT_CONTINUE: Record<Observed, boolean>` table literal
- [ ] 4.4 Implement `Cooldown.shouldThrottle(sid, currentRound, threshold)` reading `Memory.lastCompactedAt`
- [ ] 4.5 Implement `SessionCompaction.run(input)`: cooldown check → walk chain → write Anchor → mark compacted; emit `log.info` per AGENTS.md rule 1 on every kind transition
- [ ] 4.6 Unit test: `run({observed: "rebind"})` never appends synthetic Continue (R-6 acceptance)
- [ ] 4.7 Unit test: `run({observed: "manual"})` with non-empty Memory returns "continue" without API call (R-4 acceptance)
- [ ] 4.8 Unit test: `run({observed: "provider-switched"})` rejects kinds 3-5 (R-5 acceptance)

## 5. Executor implementations

- [ ] 5.1 Narrative executor (C5): reads `Memory.renderForLLM`, budget-checks ≤ 30%, calls anchor-write helper
- [ ] 5.2 Schema executor (C6): reads legacy `SharedContext.snapshot`, calls anchor-write helper (used only when narrative empty)
- [ ] 5.3 Replay-tail executor (C7): reads last N raw rounds from message stream, serializes as plain text, calls anchor-write helper
- [ ] 5.4 Low-cost-server executor (C8): wraps existing `tryPluginCompaction` logic; gated on provider supporting `session.compact` hook
- [ ] 5.5 LLM-agent executor (C9): wraps existing LLM-agent compaction path; called only as final fallback
- [ ] 5.6 Unit test per executor: succeeds on happy path, returns null on insufficient input, fails loud on infrastructure error

## 6. Runloop state-driven evaluation

- [ ] 6.1 Implement `deriveObservedCondition(session)` in `prompt.ts` per design.md pseudocode
- [ ] 6.2 Replace existing rebind branch (`prompt.ts:1512`) with call to `SessionCompaction.run({observed: "rebind", ...})` — only when deriveObservedCondition returns "rebind"
- [ ] 6.3 Replace existing overflow / cache-aware branch (`prompt.ts:1585`) with call to `run({observed: "overflow"|"cache-aware"})`
- [ ] 6.4 Replace existing compaction-request task branch (`prompt.ts:1492`) with call to `run({observed: "manual"})` — keep `Memory.requestCompaction()` writing the request part
- [ ] 6.5 Verify only one `run()` call per runloop iteration max (otherwise the matrix collapse is incomplete)
- [ ] 6.6 Unit test: state-driven evaluation emits correct Observed across 7 scenario fixtures (matches sequence.json S1..S7)

## 7. Remove flag-based plumbing

- [ ] 7.1 Delete `pendingRebindCompaction` Set, `markRebindCompaction`, `consumeRebindCompaction` from `compaction.ts`
- [ ] 7.2 Delete `markRebindCompaction` call at `processor.ts:734` (mid-stream account switch); keep pin-update logic
- [ ] 7.3 Delete `cooldownState` Map; rewrite `recordCompaction` as deprecated shim → `Memory.markCompacted`
- [ ] 7.4 Code grep: confirm zero remaining callers of deleted symbols outside the deprecation shim layer
- [ ] 7.5 Unit test: 2026-04-27 infinite-loop scenario (real account rotation) produces exactly one rebind Anchor (S4 acceptance)

## 8. Anchor unification (DD-8)

- [ ] 8.1 Drop `lastMessageId` from rebind-checkpoint write path; on-disk format becomes `{sessionID, snapshot, timestamp}`
- [ ] 8.2 Update rebind-startup recovery to read most-recent compaction part from message stream (replaces lastMessageId lookup)
- [ ] 8.3 Legacy checkpoints retain readable `lastMessageId` field; new code ignores it
- [ ] 8.4 Manual smoke: kill daemon mid-session, restart, verify session resumes correctly using new anchor-only recovery path

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
