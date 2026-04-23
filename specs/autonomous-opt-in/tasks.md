# Tasks

Execution checklist for autonomous-opt-in. Tasks are phased so each phase ships a coherent, testable slice. Per plan-builder §16.1, only the current phase's unchecked items should be materialized into TodoWrite at any time — not the whole file at once.

## Revision 2026-04-23 — main-as-SSOT pivot

Discovered that `shelf/autonomous-opt-in` already shipped Phase 1 (storage + atomic flag + Bus events) and Phase 2 (R0+R1+R2+R3 gate + workflow-runner wiring) in commits `6db33208d` and `ed8e9be2e`, but never merged to main. A separate fix `1ed57f092` landed on main instead, collapsing the richer gate into a single `workflow.autonomous.enabled` boolean.

User decision (2026-04-23): **main is the SSOT**. Shelf branch is abandoned. Phase 1+2+3's layered infrastructure is dropped because main's single-flag gate already covers the essential behaviour.

Phase mapping after revision:

| Old phase | Status | Why |
|---|---|---|
| 1. Storage + arm flag | `[-]` **cancelled — superseded by `workflow.autonomous.enabled` on main** | Atomic flag, history trail, Bus events all either exist in simpler form or are deemed non-essential |
| 2. Runtime gate wiring | `[-]` **cancelled — already done on main via `1ed57f092`** | `not_armed` path exists; R0+R1+R2+R3 layering is out of scope |
| 3. plan-builder session binding | `[-]` **cancelled — no SessionActiveSpec on main to bind to** | R6 demote-on-edit also dropped |
| 4 → **new 1**. Trigger phrase matcher | `[ ]` | Delivers the core verbal-arm feature |
| 5 → **new 2**. Disarm observer | `[ ]` | Needed so arm doesn't leak across turns |
| 6 → **new 3**. Todolist refill | `[ ]` | Optional polish; keeps pump alive after drain |
| 7 → **new 4**. Cleanup + docs | `[ ]` | |
| 8 → **new 5**. Integration + verification | `[ ]` | |

From here on in this file, sections 1/2/3 remain as `[-]` strike-through history; sections 4-8 keep their numbering but represent the live work. (Renaming the headings would break outbound links from architecture.md and handoff.md.)

## 1. Storage + arm flag infrastructure — CANCELLED (superseded by `workflow.autonomous.enabled` on main)

- [-] ~~1.1 Define `SessionActiveSpec` Storage key namespace~~ cancelled: no session↔spec binding needed on main
- [-] ~~1.2 Define `AutorunArmed` Storage key namespace with atomic flip helper~~ cancelled: `workflow.autonomous.enabled` already serves as the flag
- [-] ~~1.3 Wire `flag.ts` to emit Bus events~~ cancelled: a lightweight equivalent is added inside new-Phase-1 (4.x) as part of the phrase matcher
- [-] ~~1.4 Add unit tests covering idempotent write, history append, Bus event emission~~ cancelled with the infrastructure

## 2. Runtime gate wiring — CANCELLED (already on main via `1ed57f092`)

- [-] ~~2.1 Implement `isAutorunArmed(sessionID)` in `autorun/gate.ts`~~ cancelled: main uses `workflow.autonomous.enabled` directly
- [-] ~~2.2 Replace `// autonomous is always-on` in `inspectPendingContinuationResumability`~~ cancelled: already done on main (workflow-runner.ts:307)
- [-] ~~2.3 Replace `// autonomous is always-on` in `shouldInterruptAutonomousRun`~~ cancelled: already done on main (workflow-runner.ts:628)
- [-] ~~2.4 Short-circuit `planAutonomousNextAction` when disarmed~~ cancelled: already done on main (workflow-runner.ts:571)
- [-] ~~2.5 Guard `enqueueAutonomousContinue` with gate~~ cancelled: revisit in new-Phase-2 when wiring disarm observer
- [-] ~~2.6 Remove L2 verify-nudge branch~~ cancelled: already removed on main

## 3. plan-builder script extensions — CANCELLED (no SessionActiveSpec to bind)

- [-] ~~3.1 Extend `plan-promote.ts` to accept `--session <sid>` flag~~ cancelled with binding
- [-] ~~3.2 Write `SessionActiveSpec` binding on promotion~~ cancelled
- [-] ~~3.3 Invoke MCP `question` tool on promotion~~ cancelled — question-based arming (R3b) is also out of scope for the revised plan; verbal phrase (R3a) is the only arm path
- [-] ~~3.4 Create `scripts/lib/r6-demote.ts`~~ cancelled: no `AutorunArmed` to flip, no session binding to demote
- [-] ~~3.5 Thread `r6-demote` preCheck into write scripts~~ cancelled
- [-] ~~3.6 Unit tests for plan-promote + r6-demote~~ cancelled

## 4. tweaks.cfg + trigger phrase matcher  (**new Phase 1** under revised scope)

- [x] 4.1 Extend `TweaksConfig` reader to parse `autorun.trigger_phrases` (array&lt;string&gt;) with seed defaults per DD-8. ~~`autorun.demote_on_disarm`~~ (dropped — no R6 to demote). **Landed on beta/autonomous-opt-in-main-ssot 723dcb902** — also added `autorun.disarm_phrases` for Phase 5 detection. 25 existing tweaks tests still pass.
- [x] 4.2 Implement arm-intent-detector at user-message ingest — new `packages/opencode/src/session/autorun/detector.ts` (pure-logic: `detectAutorunIntent` + `extractUserText`). Whole-phrase case-insensitive match.
- [x] 4.3 On match, flip `workflow.autonomous.enabled` via `Session.updateAutonomous({enabled})`. ~~Enqueue a continuation round~~ **not needed** — detector fires inside `SessionPrompt.prompt()` before `runLoop`, so the user's arm-phrase message IS the round-of-record; post-round continuation picks up the new flag. Both `arm` and `disarm` intents handled (disarm flips to false, natural quiescence). Idempotent: re-arm with same state is a no-op log.
- [x] 4.4 Seed default phrase list in `templates/system/tweaks.cfg` (the actual file; task originally said `opencode.cfg` but that's a different file — tweaks.cfg is the tunables file). Seed set: `接著跑|自動跑|開 autonomous|autorun|keep going|continue autonomously` + disarm set `停|暫停|stop|halt`.
- [x] 4.5 Tests: 18 new detector tests (positive/negative/case/multilingual/embedded/empty-config/whitespace/trigger-wins/first-matches) + 5 new tweaks parser tests (defaults/pipe-separated/trim-and-drop-empty/empty-disables/sync-accessor). 48 pass across both files, 0 fail.

## 5. Disarm observer  (**new Phase 2** under revised scope)

- [x] 5.1 Implement `disarm-observer` subscriber in `packages/opencode/src/session/autorun/observer.ts`. Listens on `KillSwitchChanged` with `active=true`. ~~Non-continuation user messages~~ already handled by the Phase 4 verbal disarm detector — no duplication here.
- [x] 5.2 Sweep flips `workflow.autonomous.enabled = false` via `Session.updateAutonomous({enabled: false})` for every armed root session; subagents skipped (they inherit parent's gate). Structured log `"autorun disarmed by killswitch"` per session + sweep summary log.
- [x] 5.3 Registered at daemon startup (`index.ts` alongside the other `register*` subscriber calls — this is where `pending-notice-appender` etc. live). `Instance.provide` was the original plan but the actual registration point in main is top-level index.ts; observer is idempotent via `_registered` guard.
- [x] 5.4 Tests — 10 unit tests via injected-deps `runDisarmSweep`: disarms armed root / skips disarmed / skips subagent / skips no-workflow / flips multiple / no-op zero-armed / one update failure doesn't abort sweep / empty list. 57 pass across Phase 4+5 tests.

## 6. Todolist refill  (**new Phase 3** under revised scope)

- [x] 6.1 Implement `autorun/refill.ts` — `parseTasks` + `findRefillCandidate` + `phaseToTodoSeed` + `attemptRefill`. Active spec discovered by scanning `Instance.directory/specs/*/.state.json` for `state==="implementing"`. Ambiguity (zero or multiple matches) declines with `no_spec_found` / `multiple_specs_found`.
- [x] 6.2 Integrated at `decideAutonomousContinuation` (not `planAutonomousNextAction` — `planAutonomousNextAction` is pure). When armed + `todo_complete`, `attemptRefill` fires; if materialized, re-evaluates with fresh todos so the runloop continues naturally.
- [x] 6.3 Refill-empty path flips `workflow.autonomous.enabled = false` via `Session.updateAutonomous` and sets `stopReason: "plan_drained"` via `Session.setWorkflowState`. Log carries the refill decline reason (`no_spec_found` / `multiple_specs_found` / `no_pending_phase` / `tasks_unparseable`).
- [x] 6.4 Tests — 12 pure-logic tests covering parseTasks (mixed states, revision heading ignored, empty, whitespace tolerance, escaped content), findRefillCandidate (lowest-N wins, cancelled-only skipped, all-done null, empty null), phaseToTodoSeed (pending-only emission, id uniqueness, empty seed). 26 workflow-runner tests still pass.

## 7. Cleanup + docs  (**new Phase 4** under revised scope)

- [ ] 7.1 ~~Delete `session.plan` command block in `use-session-commands.tsx:87-96`~~ verify it still exists on main; if gone, mark complete
- [ ] 7.2 ~~Delete `permissions.autoaccept.enable` / `permissions.autoaccept.disable` blocks~~ verify same; if already removed, mark complete
- [ ] 7.3 Remove any unused i18n strings tied to deleted commands
- [ ] 7.4 Update `specs/architecture.md` runloop section to describe verbal-arm + disarm lifecycle
- [ ] 7.5 Update `templates/prompts/SYSTEM.md` with a short "autorun is opt-in, triggered by phrase" note (one line)
- [ ] 7.6 ~~Update plan-builder SKILL.md §16 with R3a/R3b and R6 obligations~~ dropped — R3b and R6 out of scope under this revision
- [ ] 7.7 Write `docs/events/event_2026-04-23_autonomous_opt_in_main_ssot.md` event log

## 8. Integration + verification  (**new Phase 5** under revised scope)

- [ ] 8.1 Run full `bun test` suite; fix regressions
- [ ] 8.2 Manual verification: chat session ends without 30s latency (regression guard)
- [ ] 8.3 Manual verification: speak trigger phrase → armed session pumps continuation; killswitch disarms
- [ ] 8.4 ~~Manual verification: R6 — edit spec.md while state=implementing, confirm state demotion + disarm~~ dropped — R6 out of scope
- [ ] 8.5 Attach validation evidence (test output, manual observation notes) to `handoff.md` Execution-Ready Checklist
- [ ] 8.6 Promote `.state.json` `implementing → verified`
