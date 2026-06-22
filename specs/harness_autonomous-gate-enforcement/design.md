# Design: harness_autonomous-gate-enforcement

## Context

The autonomous supervisor halted a live session with `ParalysisDetectedError`
even though the model was capable and its work was done. RCA traced the halt to a
documentation todo falsely keyword-flagged `architecture_change/needsApproval`,
an approval gate (`requireApprovalFor`) that is defined but never enforced, and
the absence of any model primitive to request approval — so the model dithered
against a phantom lock with no key until the paralysis detector nudged-then-halted.
This design makes the autonomous loop's approval gate real: runtime-owned,
deterministically suspending, with a model-invokable key, and no false gate.

## Architecture

The autonomous loop has two interacting subsystems, both in
`packages/opencode/src/session/`:

- **Continuation / gate** — `workflow-runner.ts` decides each turn-end whether to
  re-stimulate the model (`planAutonomousNextAction`, :568-646) and owns the
  `waiting_user` / `blocked` state machine plus `NON_RESUMABLE_WAITING_REASONS`
  (:267-277). Todo action metadata is inferred server-side in `todo.ts`
  (`inferActionFromContent`, :61-94), invoked from `tool/todo.ts` on every
  `TodoWrite`. Policy lives in `index.ts` `AutonomousPolicy` (:196,427).
- **Paralysis recovery** — `prompt.ts` runloop (:2586-2960) detects repeated
  turns (tool-signature / narrative-Jaccard / preface / no-progress), injects one
  synthetic nudge (`selectParalysisNudge`, :468-483; nudge at :2894-2934), and
  halts with `ParalysisDetectedError` if repetition survives the nudge (:2940-2960).

**Current failure path** (verified against the stuck session): a todo whose text
contains "architecture" → `inferActionFromContent` stamps
`architecture_change/needsApproval` (todo.ts:76-82) → but nothing enforces it
(workflow-runner.ts:637-640 "No pre-emptive gates") → the model is resumed into a
step it believes needs approval, with no verb to request it → it dithers (writes
nothing, reads only) → paralysis detector nudges (prompt.ts:2915) → still dithers
→ halt (prompt.ts:2948).

**Target path**: the runtime detects the gate at the continuation decision and
suspends deterministically into `waiting_user` (reusing the existing
non-resumable-reason machinery), surfacing a real approval prompt. The model
never re-enters the ungovernable step, so the paralysis detector never sees the
dither. The model can also *proactively* trigger the same suspend via a handback
verb. The keyword false-positive that created the phantom gate is removed.

## Decisions

(Recorded via `spec_record_decision` once at `designed` state; mirrored here.)

- **DD-1 — Runtime owns the gate.** Make `AutonomousPolicy.requireApprovalFor`
  (index.ts:196,427) live. In `planAutonomousNextAction` (workflow-runner.ts:568-646),
  before re-stimulating the model into an actionable todo whose
  `action.kind ∈ requireApprovalFor`, DETERMINISTICALLY suspend: set workflow
  `state=waiting_user`, `stopReason=approval_required:<kind>`, and add that
  `stopReason` family to `NON_RESUMABLE_WAITING_REASONS` (workflow-runner.ts:267-277)
  so the loop does not auto-resume until the user acts. Replaces the
  "No pre-emptive gates" stance (workflow-runner.ts:637-640). Implements
  `autonomous-opt-in` R5 — a spec-vs-code divergence, not a new requirement.

- **DD-2 — Give the model the key.** Add a first-class, model-invokable
  "request approval / handback to user" signal via a **reserved todo status
  `awaiting_approval`** the model sets through `TodoWrite` (LOCKED 2026-06-21:
  chosen over a dedicated `request_approval` tool because `tool/todo.ts` is
  already the server-owned enrichment point — smaller surface, no new tool, and
  the status naturally rides the existing todo projection the runtime already
  inspects). It routes into the SAME suspend machinery as DD-1 (`waiting_user` +
  non-resumable `stopReason`) and the SAME path already used by
  `PermissionNext.RejectedError` / `Question.RejectedError`
  (workflow-runner.ts:393-408,1112). No new transport/UI. This is the key the lock
  always implied. To stay discoverable, the model's todo-status enum doc + the
  autonomous system prompt must name `awaiting_approval` as the way to pause for
  sign-off.

- **DD-3 — Remove the false gate.** Delete the `architecture_change` keyword rule
  from `inferActionFromContent` (todo.ts:76-82). Rationale: (a) it is the
  false-positive source (doc chores containing "architecture"/"refactor" get
  trapped); (b) "architecture change" is not a single gated tool call, so
  inferring it from prose cannot be enforced precisely anyway; (c) genuinely
  dangerous actions — `push`, `destructive` — are already gated at
  tool-permission time, and what remains is covered by the model's explicit DD-2
  declaration. KEEP the `push`/`destructive` keyword inference (LOCKED 2026-06-21:
  cheap insurance; only the `architecture_change` rule is removed) — but DD-1's
  enforcement must be idempotent with the tool-permission gate so a
  push/destructive step cannot suspend twice (see DD-1 anti-double-suspend).

- **DD-4 — Paralysis defers to gates.** In the paralysis runloop (prompt.ts:2586-2960),
  before nudging/halting, check whether the current turn's non-progress is
  gate-induced: head todo is `awaiting_approval` / `needsApproval` blocked, or the
  session is in a non-resumable `waiting_user` state. If so, do NOT count it
  toward the paralysis ladder and do NOT halt — the correct outcome is a clean
  suspend, which DD-1/DD-2 already produce. Largely defensive once DD-1/DD-2 land
  (the model won't be resumed into the dither), but it closes the class so a
  future advisory flag can never again be "nudged-then-killed."
- **DD-5**: DD-5 (approval resume semantics — no auto-rearm): when the gate suspends (waiting_user + approval_needed), autonomous stays ARMED but the supervisor cannot auto-resume (non-resumable reason). "Approval" is the user re-engaging — a non-synthetic user message, which under autonomous-opt-in R5 disarms autorun and drives the gated step INTERACTIVELY. The gate intentionally does NOT auto-rearm autopilot after approval: re-arming autonomous execution immediately after a human approval gate would defeat the gate's purpose (human-in-the-loop). To continue autonomous execution of subsequent steps, the user explicitly re-arms. This is safe-by-default and reuses existing machinery (no new approve-and-resume transport). The integration test (task 2.7) confirms the suspend keeps autonomous enabled; the interactive resume is the existing R5 path.
- **DD-6**: DD-6 — Retire verbal-trigger autorun (phased, arm-neutralization first). User goal (2026-06-22): retire the verbal-trigger autorun mechanism. Phase 1 = neutralize arm only: detectAutorunIntent (autorun/detector.ts:20, called prompt.ts:1584) stops flipping workflow.autonomous.enabled=true; remove the trigger phrases from config so no user message arms autorun. The autonomous-continuation subsystem (planAutonomousNextAction, observer, freerun-bridge) stays in place but becomes a dead path for verbal-triggered sessions. Later phases remove the now-dead code. CONSEQUENCE for this plan: DD-1 and DD-2 both fire INSIDE planAutonomousNextAction, which early-returns {stop, not_armed} when enabled===false (workflow-runner.ts:610-611). With arm retired they are unreachable dead code → DD-1/DD-2 are SHELVED (not merged). Only DD-3 (todo.ts keyword false-gate removal, fires on every TodoWrite regardless of arm) and DD-4 (paralysis defers to gates, runs for all sessions) — the accident-necessary, arm-independent subset — merge to main.
- **DD-7**: DD-7 — freerun is OUT of scope; only verbal-trigger autorun retires. freerun mode also flips workflow.autonomous.enabled=true (prompt.ts:1616-1617) but is a distinct ContextNode-driven engine (different drive model, freerun-bridge). Retirement targets ONLY the verbal-trigger arming path (接著跑/autorun/keep going). The detector/continuation code must distinguish the two: neutralize verbal arm without disabling freerun's flag flip. freerun-driven sessions keep working unchanged.
- **DD-8**: DD-8 — arm-independent subagent-completion continuation (folds in BR issue_20260622_execution_mode_subagent_continuation_arm_gated). With DD-6 retiring the verbal arm flag, the existing continuation path is fully arm-gated and would die: planAutonomousNextAction early-returns {stop, not_armed} when enabled===false (workflow-runner.ts:610-611), shouldInterruptAutonomousRun returns false when enabled===false (:750), and the runloop terminal-turn continuation (prompt.ts:4351) flows through the same gate. Decision: decouple subagent-completion resume from the autonomous.enabled flag so that during execution mode (todolist has pending/in_progress residue, no stop gate) the orchestrator self-dispatches the next step after a subagent finishes — without needing a verbal autorun trigger or a runtime-injected synthetic continuation. Boundaries preserved: bare/passthrough sessions stay strictly one-shot (prompt.ts:4315); subagent sessions (parentID set) are still parent-driven and never run the continuation engine themselves (workflow-runner.ts:605-606); freerun path (DD-7) unchanged. This makes execution-mode continuation a property of having actionable todos + no stop gate, not of an arm flag — which is the correct model once verbal autorun is gone.
- **DD-9**: DD-8 SCOPE LOCK (2026-06-22, evidence-closed + user-narrowed): DD-8 is NOT a new capability — it is a REGRESSION FIX for DD-6. Root-cause chain (source-verified): "subagent 完成就自動接" was always provided by the pending-notice-appender Bus subscriber (bus/subscribers/pending-notice-appender.ts:177-189), which on TaskCompletedEvent calls enqueueAutonomousContinue to wake the parent runloop — this path does NOT check autonomous.enabled, so it fired even with arm off. BUT after that woken turn drains the notice, whether the orchestrator CONTINUES to the next step is decided by runloop terminal-turn → decideAutonomousContinuation → planAutonomousNextAction, which early-returns {stop, not_armed} when enabled===false (workflow-runner.ts:610-611). DD-6 pinned arm permanently false (triggerPhrases:[]), so post-DD-6 the appender still "kicks" once per subagent completion but the turn stops right after draining — exactly the BR symptom ("要靠注入才動，注入消化完就停"). FIX (user-narrowed to Phase 1 = subagent path only): on a continuation turn that was triggered by subagent completion (task_completion/task_failure triggerType, or lastDecisionReason indicates appender-driven resume), planAutonomousNextAction must NOT early-return not_armed; instead evaluate todolist residue — pending/in_progress todo + no stop gate → continue; else stop(todo_complete). A turn ended by a normal user prompt (not subagent-triggered) is OUT of scope for Phase 1 and keeps current behavior. Boundaries preserved: bare one-shot (prompt.ts:4315), subagent parentID parent-driven (workflow-runner.ts:605-606), freerun (DD-7), and DD-1/DD-2 approval gate (isAutonomousApprovalGated must still fire before the todolist-continue branch). Signal = todolist residue (user-locked), replacing the arm flag as the continuation predicate on this narrow path only.
- **DD-10**: DD-1/DD-2 ended up LIVE on main — supersedes DD-6's "DD-1/DD-2 SHELVED (not merged)" wording. Reconciliation of an internal contradiction: DD-6 proposed shelving DD-1/DD-2 as dead-once-arm-retired, but DD-9's scope-lock then required "isAutonomousApprovalGated must still fire before the todolist-continue branch", and DD-8 (commit `2c4a830c2`) routes the arm-independent subagent-completion path THROUGH planAutonomousNextAction's approval gate. Verified state (2026-06-22): commit `86b0c58de` (DD-1/DD-2 + `isAutonomousApprovalGated` + `awaiting_approval` + `approval_required`) IS an ancestor of main HEAD and `isAutonomousApprovalGated` is present in current source. Empirical proof of load-bearing: an attempt to remove DD-1/DD-2 made the DD-8 test "explicit awaiting_approval handback suspends even on a subagent-triggered unarmed turn" FAIL; the removal was fully reverted. ∴ all four original DDs are live and interlocking (DD-3 kills the false gate; DD-1/DD-2 are the runtime-owned gate; DD-4 makes paralysis defer to it; DD-8 stands on DD-1/DD-2 for orchestrator self-dispatch). DD-1/DD-2 MUST NOT be removed until DD-8's dependency on the `awaiting_approval` gate is migrated. Any "inert/dead-code" framing in this package or in `issues/closed/20260622_autonomous_approval_gate_and_paralysis_merge_scope_issue.md` is superseded by this entry.

## Code Anchors

- `packages/opencode/src/session/workflow-runner.ts:568-646` — `planAutonomousNextAction` (DD-1 enforcement site)
- `packages/opencode/src/session/workflow-runner.ts:637-640` — "No pre-emptive gates" comment (the stance DD-1 replaces)
- `packages/opencode/src/session/workflow-runner.ts:267-277` — `NON_RESUMABLE_WAITING_REASONS` (DD-1/DD-2 suspend target)
- `packages/opencode/src/session/workflow-runner.ts:393-408,1112` — existing RejectedError → blocked path (DD-2 reuse)
- `packages/opencode/src/session/todo.ts:61-94` — `inferActionFromContent` (DD-3 edit; :76-82 is the keyword rule)
- `packages/opencode/src/session/todo.ts:258,299` — `needsApproval` consumers (host-adopt replan; verify DD-2/DD-3 interaction)
- `packages/opencode/src/session/index.ts:196,427` — `AutonomousPolicy.requireApprovalFor` (DD-1 config)
- `packages/opencode/src/tool/todo.ts` — `TodoWrite` enrichment entry (DD-2 status, DD-3 inference call site)
- `packages/opencode/src/session/prompt.ts:2586-2960` — paralysis runloop (DD-4)
- `packages/opencode/src/session/prompt.ts:468-483` — `selectParalysisNudge` (DD-4 context)

## Goals / Non-Goals

### Goals
- Make `requireApprovalFor` an enforced runtime gate (implement autonomous-opt-in R5).
- Give the model a deterministic "request approval / handback" key (`awaiting_approval`).
- Eliminate the `architecture_change` keyword false-positive.
- Make the paralysis detector defer to legitimate gate-induced suspends.

### Non-Goals
- No new approval UI/transport — reuse the existing question/permission surface.
- No change to autonomous opt-in arming conditions (R1-R4) or to paralysis
  detection signals themselves.
- No prompt-tuning the model to "self-gate better" — the fix is structural.

## Risks / Trade-offs

- **Over-suspending** if `requireApprovalFor` is too broad → mitigated by DD-3
  removing the false `architecture_change` inference, leaving only push/destructive
  which map to genuinely gated actions.
- **Double-suspend** between DD-1's todo-level gate and the existing
  tool-permission gate → DD-1 enforcement must be idempotent (check existing
  `blocked`/`waiting_user` before suspending again).
- **Discoverability** of the `awaiting_approval` status → mitigated by documenting
  it in the todo-status enum and the autonomous system prompt.
- **In-memory paralysis state** (prompt.ts) is per-daemon; DD-4's gate check must
  read durable workflow state, not only the in-memory ladder.

## Critical Files

- `packages/opencode/src/session/workflow-runner.ts` — gate enforcement + suspend (DD-1, DD-2)
- `packages/opencode/src/session/todo.ts` — action inference (DD-3) + `needsApproval` consumers
- `packages/opencode/src/tool/todo.ts` — `TodoWrite` enrichment + `awaiting_approval` status (DD-2)
- `packages/opencode/src/session/index.ts` — `AutonomousPolicy.requireApprovalFor` (DD-1)
- `packages/opencode/src/session/prompt.ts` — paralysis runloop (DD-4)

## Related specs

- **Implements**: `harness/autonomous-opt-in` (R5 — disarm on approval/blocker).
- **Sibling (same "false session kill" class)**: `question-tool_idle-watchdog-false-kill`
  — there the stream-idle watchdog falsely killed a `question` wait; here the
  paralysis detector falsely halts a gate wait. Both are "a watchdog firing on a
  legitimate pause." Worth a shared invariant: watchdogs must recognize
  legitimate suspends.

## Resolved design questions (2026-06-21, user-confirmed)

- **DD-2 carrier → reserved todo status `awaiting_approval`** (not a new tool).
- **DD-3 scope → remove ONLY the `architecture_change` keyword rule**; keep
  `push`/`destructive` inference as cheap insurance, with DD-1 enforcement made
  idempotent against the tool-permission gate (no double-suspend).
