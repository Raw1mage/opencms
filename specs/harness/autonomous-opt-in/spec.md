# Spec: autonomous-opt-in

## Purpose

Flip the runloop's autonomous-continuation default from `always-on` to `opt-in`. Autonomous execution (continuous pump of `enqueueAutonomousContinue` rounds) must require an explicit, auditable arm signal sourced from the plan-builder lifecycle and user intent. The arm signal is consumed by a single runtime gate; all previous layered compensations (empty-todolist nudge + Continuation Gate self-check) are removed.

## Requirements

### Requirement: R0 — Default idle

Every session begins with autorun disabled. No continuation is pumped unless the session is explicitly armed.

#### Scenario: chat-only session never pumps

- **GIVEN** a session with no bound spec
- **AND** `autorun_armed` flag is absent or false for that session
- **WHEN** the user sends any message and the assistant finishes its turn
- **THEN** `planAutonomousNextAction` returns `{type: "stop", reason: "not_armed"}`
- **AND** no synthetic user message is injected
- **AND** the turn ends within the normal LLM latency budget (no extra gate-check round)

### Requirement: R1 — Arm condition: validated plan binding

The session must have a Storage binding to a spec slug whose `.state.json.state ∈ {planned, implementing}`.

#### Scenario: no spec bound

- **GIVEN** a session with `session_active_spec` key unset
- **WHEN** any arm trigger fires (verbal or question-based)
- **THEN** arm is refused with `log.warn "autorun arm refused: no active spec binding"`
- **AND** `autorun_armed` remains false

#### Scenario: bound spec is not in build-ready state

- **GIVEN** a session bound to `specs/foo/` with `state === "designed"`
- **WHEN** any arm trigger fires
- **THEN** arm is refused with `log.warn "autorun arm refused: state=designed not in {planned, implementing}"`

#### Scenario: bound spec is in `planned` state

- **GIVEN** a session bound to `specs/foo/` with `state === "planned"`
- **AND** R2 and R3 also hold
- **WHEN** arm trigger fires
- **THEN** `autorun_armed` is set to true
- **AND** a history event `autorun.armed` is recorded with `reason: "<trigger kind>"`

### Requirement: R2 — Arm condition: unfinished todolist

`Todo.nextActionableTodo(sessionID)` must be non-null at arm time.

#### Scenario: empty todolist at arm time

- **GIVEN** a session bound to a `planned`-state spec with no todos materialized yet
- **WHEN** arm trigger fires
- **THEN** arm is refused with `log.warn "autorun arm refused: no actionable todo"`
- **AND** a hint event suggests running `plan-promote --to implementing` (which materializes phase 1 tasks)

### Requirement: R3 — Arm condition: explicit trigger

One of two trigger channels must fire. No other path arms the session.

#### Scenario R3a: verbal trigger match

- **GIVEN** `tweaks.cfg autorun.trigger_phrases = ["start building", "開始實作", "execute the plan", ...]`
- **AND** a session bound to a spec in `planned` state with unfinished todos
- **WHEN** the user sends a message whose text matches any configured phrase (case-insensitive, whole-phrase)
- **THEN** `autorun_armed` becomes true
- **AND** history event records `reason: "verbal_trigger:<matched phrase>"`

#### Scenario R3b: question-based trigger from plan-builder

- **GIVEN** the user runs `bun run plan-promote.ts specs/foo/ --to implementing --session <sid>`
- **WHEN** the script completes the state transition
- **THEN** the script invokes the MCP `question` tool with: question="Start autonomous build now?", options=["Yes — arm autorun", "No — stay idle"]
- **AND** if the user selects "Yes — arm autorun", `autorun_armed` becomes true
- **AND** if the user selects "No" or doesn't answer, `autorun_armed` stays false

### Requirement: R4 — Continuation refill

While armed, when the todolist drains, the runtime refills from the plan's `tasks.md` next phase/section. Refill continues only while R1 holds.

#### Scenario: phase rollover during armed execution

- **GIVEN** an armed session with TodoWrite holding only phase 1 tasks
- **AND** every phase 1 item is `completed`
- **WHEN** `planAutonomousNextAction` runs and sees no actionable todo but `autorun_armed === true` and R1 still holds
- **THEN** the runtime reads `specs/<slug>/tasks.md`, finds the next `## N.` heading with unchecked items, and calls TodoWrite to materialize them
- **AND** the runloop continues with the new batch

#### Scenario: full plan drain

- **GIVEN** an armed session where `tasks.md` has no remaining unchecked items
- **WHEN** phase rollover attempts refill
- **THEN** refill returns "empty"
- **AND** `autorun_armed` is flipped to false
- **AND** the session logs `autorun.completed` and the runner returns `{type: "stop", reason: "plan_drained"}`
- **AND** plan-builder is left to handle the `implementing → verified` promotion via its usual gate

### Requirement: R5 — Disarm on interruption

Any non-synthetic user message, blocker, or abort disarms autorun. `.state.json` is NOT modified.

#### Scenario: user types during armed execution

- **GIVEN** an armed session currently pumping continuations
- **WHEN** a non-synthetic user message arrives
- **THEN** `autorun_armed` is flipped to false before the next `planAutonomousNextAction` call
- **AND** history event records `autorun.disarmed reason: "user_message"`
- **AND** `.state.json.state` is unchanged

#### Scenario: blocker fires

- **GIVEN** an armed session
- **WHEN** any of: approval-required, question tool called by AI, non-recoverable error, killswitch, abort signal
- **THEN** `autorun_armed` flips to false with corresponding reason

### Requirement: R6 — Plan-edit forces state demotion

While `state === "implementing"`, non-checkbox edits to the bound spec's artifacts trigger `implementing → planned` demotion AND disarm.

#### Scenario: user runs plan-amend during implementing

- **GIVEN** an armed session bound to `specs/foo/` with `state === "implementing"`
- **WHEN** the user runs `bun run plan-promote.ts specs/foo/ --mode amend ...`
- **THEN** the script detects `state === "implementing"` and, before applying `amend`, demotes `state` to `planned` with history `{mode: "revise", reason: "plan edit during implementing forces re-review"}`
- **AND** `autorun_armed` flips to false
- **AND** the `amend` operation then runs against the now-`planned` state

#### Scenario: user edits spec.md in raw editor (optional file-watcher path)

- **GIVEN** file-watcher layer enabled (OQ-1 decision)
- **AND** an armed session bound to `specs/foo/` with `state === "implementing"`
- **WHEN** the user edits `specs/foo/spec.md` outside any plan-builder script
- **THEN** the watcher detects the write, applies `implementing → planned` demotion, and disarms
- **AND** a `log.warn` surfaces the bypass path

#### Scenario: checkbox toggle does not demote

- **GIVEN** an armed session bound to `specs/foo/` with `state === "implementing"`
- **WHEN** the AI or user toggles `- [ ]` to `- [x]` in `tasks.md` (checkbox-only diff)
- **THEN** state remains `implementing`
- **AND** autorun stays armed
- **AND** `plan-sync.ts` records the checkbox toggle per existing contract (§16.3)

## Acceptance Checks

- Turn-end latency in chat-only sessions drops by one full LLM round (eliminate ~30s observed gate-check)
- No synthetic user message contains the literal substring "Continuation Gate" unless `autorun_armed === true`
- `workflow-runner.test.ts` covers R0 (default stop), R1×R2×R3 (arm matrix), R4 (refill + drain), R5 (each disarm reason), R6 (demote + preserve state)
- `plan-promote.test.ts` covers R3b (question tool invocation) and R6 (pre-apply demotion)
- No silent fallback: every refused arm or disarm writes a `log.warn` with reason
- `/plan` and `/auto-yes-*` slash commands removed; `grep -r` in webapp returns no references
