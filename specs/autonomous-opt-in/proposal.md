# Proposal: autonomous-opt-in

## Why

The runloop's autonomous-continuation layer is currently hardcoded to `always-on` at three sites ([workflow-runner.ts:313, :648, and the body of `planAutonomousNextAction`](../../packages/opencode/src/session/workflow-runner.ts)), with no session-scoped enable flag. Every turn-end — regardless of whether the user is chatting, asking a question, or executing a plan — fires the drain-check path, which injects a synthetic user message ("Continuation Gate") and consumes one full LLM round (~30 seconds of observed latency) just to confirm the AI has nothing more to say.

This has produced a visible design spiral:

| Layer | Intent | Side effect |
|---|---|---|
| L1 | "todolist presence = continue signal" | In chat (no todolist), runloop has no break condition |
| L2 | "When todolist is empty, nudge AI to produce one" | AI hallucinates todos, infinite loop |
| L3 | "AI self-checks a Continuation Gate before continuing" | ~30s gate-check round on every turn-end, even in chat |
| L4 (this spec) | "Read plan `.state.json` to decide whether to pump at all" | — |

The root cause: L1 conflates *execution state* (is there a todolist?) with *execution intent* (does the user want autonomous execution?). Each subsequent layer patches over that conflation. This spec replaces L1-L3 with an explicit opt-in signal sourced from the plan lifecycle and user intent — making autorun a **transient elevation** from the default idle state, not a default pumping loop.

**Design principle agreed with user**: autorun capability is intentionally coupled to plan-builder artifact state. Without a well-formed plan there is no sensible basis for autonomous execution, so requiring a validated plan as the pre-condition is a natural invariant, not an accidental dependency.

## Original Requirement Wording (Baseline)

Recorded from conversation 2026-04-19:

> Default 應該是 no autorun。這一點先確定。
>
> 想要啟動 autorun，條件是嚴格的。
>
> 1. 要有 validated plan，
> 2. 要有未完成的 todolist
> 3. 要有 verbal command trigger
> 4. 符合前兩者的前提下，在完成 todolist 時才根據 plan 去生下一批 todolist
> 5. 中間任何人為的介入插話或 blocker 都無條件把 autorun 停掉回到 plan mode
>
> 如果實作中使用者有任何改變 plan 的情形，plan status 一定要馬上退化為 planning

## Requirement Revision History

- 2026-04-18: initial draft created via plan-init.ts
- 2026-04-19: proposal.md authored from conversation transcript; six numbered rules distilled; open questions captured

## Effective Requirement Description

**R0 — Default state is idle (no autorun).** The runloop must not pump autonomous continuations unless the session is explicitly armed.

**R1 — Arm condition: validated plan binding.** The session must have a binding to a spec folder whose `.state.json.state ∈ {planned, implementing}`.

**R2 — Arm condition: unfinished todolist.** `Todo.nextActionableTodo(sessionID) !== null` at arm time.

**R3 — Arm condition: explicit trigger.** One of the following must fire:
  - **R3a — verbal trigger:** a user message matches any phrase in the trigger list (source: `/etc/opencode/tweaks.cfg` key `autorun.trigger_phrases`)
  - **R3b — question-based trigger:** plan-builder's promote script (to `planned` or `implementing`) uses the MCP `question` tool to ask "start building now?"; user answering yes arms autorun

**R4 — Continuation refill.** While armed, when the todolist drains, the runtime pulls the next phase/section of unchecked items from `tasks.md` into TodoWrite and continues. Refill continues only while R1 still holds. If the plan is fully drained (no more unchecked tasks), autorun ends and the state may be promoted to `verified` by the usual plan-builder gate.

**R5 — Disarm on interruption.** Any of: non-synthetic user message, blocker (approval / question tool / error), killswitch, abort signal, plan state demoted below `planned` → immediately disarms autorun. The plan's `.state.json.state` is **not** auto-demoted on ordinary interruption (session-level flag flip only).

**R6 — Plan-edit forces state demotion.** If, during `implementing`, the user makes any non-checkbox edit to the bound spec's artifacts (`spec.md`, `design.md`, `tasks.md` structure, `handoff.md`, `implementation-spec.md`, `errors.md`, `invariants.md`, schema JSONs), `.state.json.state` is demoted `implementing → planned` and autorun is disarmed. Re-arming requires a fresh trigger per R3. Checkbox `[ ] ↔ [x]` toggles in `tasks.md` are normal `implementing` progress and do NOT demote.

## Scope

### IN

- **Runtime**: collapse the three `autonomous is always-on` sites in `workflow-runner.ts` into a single gate `isAutorunArmed(sessionID)` that checks R0-R3 live; remove L2 (empty-todolist nudge production) and L3 (Continuation Gate synthetic round); short-circuit `planAutonomousNextAction` when disarmed
- **Storage**: new Storage key namespace `["session_active_spec", sessionID]` mapping session → spec slug; `["autorun_armed", sessionID]` boolean flag with history entry
- **plan-builder scripts**: `plan-promote.ts` accepts `--session <id>` (or reads `OPENCODE_SESSION_ID`) to set the binding; upon promotion to `planned` or `implementing`, invokes the MCP `question` tool per R3b
- **Plan-edit detection**: hook into plan-builder's write scripts (`amend`/`revise`/`extend`/`refactor`/`sync`) to apply R6 demotion + disarm when fired while `state === "implementing"`; optional file-watcher layer as second safety net
- **Tweaks**: new `/etc/opencode/tweaks.cfg` keys `autorun.trigger_phrases` (array), `autorun.demote_on_disarm` (bool, default false — per Q4 decision)
- **Commands**: delete the dead `/plan` and `/auto-yes-enabled` / `/auto-yes-disabled` slash commands from [use-session-commands.tsx](../../packages/app/src/pages/session/use-session-commands.tsx)

### OUT

- Subagent-session autonomous gating (already stopped via existing `subagent_session` stop reason)
- UI / TUI visualization of armed state (separate follow-up spec if needed)
- Cross-session autorun (armed state is strictly per-session)
- Auto-promotion from `verified → living` (existing plan-builder flow unchanged)
- Replacing the plan-builder lifecycle itself — this spec plugs into existing `.state.json` + scripts

## Non-Goals

- **Not** preserving the current always-on behavior behind an opt-out flag. The flip is explicit and total; legacy sessions simply stop pumping until armed.
- **Not** inferring user intent from AI output — runtime recognizes intent from user input (R3a) or an explicit question answer (R3b) only, never from parsing AI-generated markers or tool-call patterns.
- **Not** extending autorun to cover chat-only interactions with "light autonomy". No autorun means no autorun.
- **Not** providing a "run without a plan" escape hatch — if the user wants autonomous execution, they must produce a plan first. This is intentional coupling, not a rough edge.

## Constraints

- **AGENTS.md 第零條** — this spec is the plan required before the implementation commit
- **AGENTS.md 第一條** — any failed lookup (missing spec binding, missing `.state.json`, trigger phrase misparse) must `log.warn` + report, not silent-fallback to old behavior
- **feedback_tweaks_cfg** — tunable thresholds belong in `/etc/opencode/tweaks.cfg` with fallback defaults
- **feedback_repo_independent_design** — session→spec binding storage uses `Global.Path.user` or Storage (user-home scoped), not repo-relative paths
- **feedback_prompt_pseudocode_style** — any new prompt text the AI consumes (e.g. question tool options, trigger-match acknowledgments) should be pseudo-code / structured, not prose advisory

## What Changes

- **Default behavior**: every session starts with autorun disabled. Pumping continuations requires explicit arming.
- **Continuation Gate prompt**: the current `runner.txt` if/else gate remains (for when autorun IS armed), but is no longer consulted when disarmed — the runtime short-circuits before the LLM round.
- **Plan lifecycle integration**: `.state.json` becomes the authoritative "is this session in build mode" source, not a reference document.
- **User UX**: chat and single-turn tasks end cleanly at turn boundary (no 30s gate-check round). Multi-turn autonomous execution requires deliberate action (promote spec + answer arming question OR type a trigger phrase).

## Capabilities

### New Capabilities

- **`autorun state machine`**: per-session `idle ↔ armed` flag with arm/disarm transitions audited in Storage
- **`session-spec binding`**: Storage key linking a session to an active spec slug; plan-builder scripts maintain it; runtime reads it
- **`verbal trigger detection`**: regex scan of user messages against `tweaks.cfg` phrase list at message ingest time; match flips arm flag if R1+R2 also hold
- **`question-based arming`**: plan-builder's promote script invokes MCP question tool; user's positive answer sets arm flag
- **`plan-edit demotion hook`**: plan-builder write scripts check `state === "implementing"` and apply R6 before executing the requested mode

### Modified Capabilities

- **`enqueueAutonomousContinue`**: guard with `isAutorunArmed(sessionID)` — if disarmed, refuse to enqueue (not silent; `log.warn` + event)
- **`planAutonomousNextAction`**: short-circuit when disarmed; otherwise retain existing todo-based logic for the armed path
- **`inspectPendingContinuationResumability` / `shouldInterruptAutonomousRun`**: both check arm state; disarmed = not resumable / should interrupt
- **`plan-promote.ts`**: accepts `--session <id>` (or env), invokes question tool at `planned`/`implementing` entries, writes session-spec binding
- **`/plan` and `/auto-yes-*` slash commands**: deleted (dead code, never properly wired — see conversation 2026-04-19)

## Impact

- **Code**: `packages/opencode/src/session/workflow-runner.ts` (major), `packages/opencode/src/session/prompt.ts` (continuation injection guard), `packages/opencode/src/storage/**` (new key namespace), `packages/app/src/pages/session/use-session-commands.tsx` (command deletion)
- **Skill scripts**: `/home/pkcs12/.claude/skills/plan-builder/scripts/plan-promote.ts` (session binding + arming question), and the other write scripts (`plan-amend`, `plan-revise`, `plan-extend`, `plan-refactor`, `plan-sync`) for R6 hook
- **Config**: `/etc/opencode/tweaks.cfg` (two new keys), `templates/opencode.cfg` (if reflected to template)
- **Docs**: `specs/architecture.md` (runloop section), `templates/prompts/SYSTEM.md` (autorun opt-in note), plan-builder SKILL.md (§16 Execution Contract gains an Arming subsection)
- **Tests**: `workflow-runner.test.ts` covered paths for armed/disarmed, R3a/R3b trigger, R6 demotion; `plan-promote.test.ts` for session binding + question invocation
- **User-observable**: 30s per-turn latency removed from chat; autonomous execution becomes an explicit action with clear visual/textual trigger

## Open Questions (to resolve during `designed` phase)

The following design choices are parked for the `designed` state pass — they refine but do not block the `proposed` framing:

- **OQ-1 — Plan-edit detection mechanism (R6)**: (i) file-watcher on spec folder, (ii) hook in plan-builder write scripts only, or (iii) both as defense-in-depth. Recommendation: (ii) as primary, (i) as optional second layer for users who edit in raw editor.
- **OQ-2 — Checkbox-toggle vs structural-edit diff heuristic**: confirmed checkbox toggles are normal `implementing` progress. Need to spec the diff rule that distinguishes `[ ] ↔ [x]` toggles from structural tasks.md edits (e.g. ignore lines matching `^- \[[x ]\]` while checking other diff hunks).
- **OQ-3 — Trigger phrase list default seed**: pending user confirmation. Conversation surfaced candidates: `start building`, `go building`, `start implementation`, `開始實作`, `執行計畫`, `execute the plan`. Will ship as `tweaks.cfg` default with user override.
- **OQ-4 — Question tool invocation timing**: fire on `plan-promote --to planned`, `--to implementing`, or both? Current draft fires on both entries so user can arm either early (ready-to-go) or at implementing-flip (hand-off moment).
- **OQ-5 — Legacy `OPENCODE_AUTONOMOUS_WITHOUT_SPEC` escape hatch**: previously floated. Current draft omits; chat-only users simply don't arm, which is the intended quiet path. Coupling autorun to plan state is a feature, not a constraint.
