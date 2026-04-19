# Tasks

Execution checklist for autonomous-opt-in. Tasks are phased so each phase ships a coherent, testable slice. Per plan-builder §16.1, only the current phase's unchecked items should be materialized into TodoWrite at any time — not the whole file at once.

## 1. Storage + arm flag infrastructure

- [ ] 1.1 Define `SessionActiveSpec` Storage key namespace with read/write/invalidate helpers in `packages/opencode/src/session/autorun/binding.ts`
- [ ] 1.2 Define `AutorunArmed` Storage key namespace with atomic flip helper in `packages/opencode/src/session/autorun/flag.ts`
- [ ] 1.3 Wire `flag.ts` to emit Bus events (`autorun.armed`, `autorun.disarmed`, `autorun.arm_refused`) on every state change
- [ ] 1.4 Add unit tests covering idempotent write, history append, Bus event emission

## 2. Runtime gate wiring

- [ ] 2.1 Implement `isAutorunArmed(sessionID)` in `packages/opencode/src/session/autorun/gate.ts` — returns true only if R0+R1+R2+R3 all hold via live reads
- [ ] 2.2 Replace `// autonomous is always-on` at [workflow-runner.ts:313](../../packages/opencode/src/session/workflow-runner.ts#L313) with gate check in `inspectPendingContinuationResumability`
- [ ] 2.3 Replace `// autonomous is always-on` at [workflow-runner.ts:648](../../packages/opencode/src/session/workflow-runner.ts#L648) with gate check in `shouldInterruptAutonomousRun`
- [ ] 2.4 Short-circuit `planAutonomousNextAction` (around [:567-605](../../packages/opencode/src/session/workflow-runner.ts#L567-L605)) when disarmed → return `{type:"stop", reason:"not_armed"}` without consulting todolist
- [ ] 2.5 Guard `enqueueAutonomousContinue` at [:1047](../../packages/opencode/src/session/workflow-runner.ts#L1047) with gate — refuse to enqueue when disarmed, log.warn, emit `autorun.arm_refused`
- [ ] 2.6 Remove L2 (the verify-nudge branch at `planAutonomousNextAction`) — when disarmed, never synthesise a verify round; when armed but drained, delegate to Phase 4 refill path

## 3. plan-builder script extensions

- [ ] 3.1 Extend `plan-promote.ts` to accept `--session <sid>` flag (fall back to `OPENCODE_SESSION_ID` env)
- [ ] 3.2 On `--to planned` or `--to implementing` promotion, write `SessionActiveSpec` binding via the runtime Storage API (via a helper CLI wrapper or direct JSON write to the known Storage path)
- [ ] 3.3 On the same promotion, invoke MCP `question` tool with fixed wording (see data-schema.json `ArmingQuestionInvocation`); if user answers Yes, write `AutorunArmed = {armed: true, reason: "question_yes"}`
- [ ] 3.4 Create shared helper `scripts/lib/r6-demote.ts` — accepts `(specPath, callerName)`, reads `.state.json`, if state===implementing: append history `{mode:"revise", from:"implementing", to:"planned"}` + flip `AutorunArmed` to false
- [ ] 3.5 Thread `r6-demote` preCheck into every write script: `plan-amend.ts` / `plan-revise.ts` / `plan-extend.ts` / `plan-refactor.ts` / `plan-sync.ts` — called before the script applies its mutation
- [ ] 3.6 Unit tests for plan-promote (session binding write + question invocation branches) and r6-demote (pre-check fires on implementing only)

## 4. tweaks.cfg + trigger phrase matcher

- [ ] 4.1 Extend `TweaksConfig` reader to parse `autorun.trigger_phrases` (array<string>) and `autorun.demote_on_disarm` (bool) with seed defaults per DD-8
- [ ] 4.2 Implement arm-intent-detector at user-message ingest (in `packages/opencode/src/session/prompt.ts` or a sibling `autorun/detector.ts`) — whole-phrase case-insensitive match across full message text
- [ ] 4.3 On match, validate R1+R2 live, then flip `AutorunArmed` with `reason: "verbal:<matched>"`; on precondition fail, `log.warn` with refuse reason + emit `autorun.arm_refused`
- [ ] 4.4 Seed default phrase list in `templates/opencode.cfg` so freshly-installed instances get the same defaults
- [ ] 4.5 Tests for phrase match (positive, negative, case, multilingual), precondition-refuse paths

## 5. Disarm observer

- [ ] 5.1 Implement `disarm-observer` subscriber in `packages/opencode/src/session/autorun/observer.ts` — listens on Bus for user-message / blocker / abort / killswitch events
- [ ] 5.2 On event, flip `AutorunArmed = {armed: false, reason: "<event kind>"}`
- [ ] 5.3 Wire observer startup in `Instance.provide` path so every session has it registered
- [ ] 5.4 Tests for each disarm reason

## 6. Todolist refill

- [ ] 6.1 Implement `autorun/refill.ts` — reads bound spec's `tasks.md`, finds next `## N.` section with unchecked items, calls TodoWrite to materialize them
- [ ] 6.2 Integrate refill path into `planAutonomousNextAction` armed-but-drained branch (replaces the old L3 verify path for this case)
- [ ] 6.3 On refill-empty (plan fully drained), flip `AutorunArmed` to false with `reason: "plan_drained"`, emit `autorun.completed`, runner returns stop
- [ ] 6.4 Tests for refill (next phase detection, empty→completed path, malformed tasks.md handled)

## 7. Cleanup + docs

- [ ] 7.1 Delete `session.plan` command block in [use-session-commands.tsx:87-96](../../packages/app/src/pages/session/use-session-commands.tsx#L87-L96)
- [ ] 7.2 Delete `permissions.autoaccept.enable` / `permissions.autoaccept.disable` blocks (`/auto-yes-enabled` / `/auto-yes-disabled`)
- [ ] 7.3 Remove any unused i18n strings tied to the deleted commands
- [ ] 7.4 Update `specs/architecture.md` runloop section to describe arm-gated pumping
- [ ] 7.5 Update `templates/prompts/SYSTEM.md` with a short "autorun is opt-in" note (one line, not a paragraph)
- [ ] 7.6 Update plan-builder SKILL.md §16 with a new subsection "Arming" describing R3a/R3b and R6 obligations
- [ ] 7.7 Write `docs/events/event_<date>_autonomous_opt_in.md` event log

## 8. Integration + verification

- [ ] 8.1 Run full `bun test` suite; fix regressions
- [ ] 8.2 Manual verification: chat session ends without 30s latency
- [ ] 8.3 Manual verification: armed session pumps continuation; user interjection disarms
- [ ] 8.4 Manual verification: R6 — edit spec.md while state=implementing, confirm state demotion + disarm
- [ ] 8.5 Attach validation evidence (test output, manual observation notes) to `handoff.md` Execution-Ready Checklist
- [ ] 8.6 Promote `.state.json` `implementing → verified`
