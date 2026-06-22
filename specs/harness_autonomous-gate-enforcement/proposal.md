# Proposal: harness_autonomous-gate-enforcement

## Why

A live autonomous session (`ses_115cfbcf…`, project `docxmcp`) halted with
`ParalysisDetectedError`: *"Loop halted: 3 consecutive turns repeated the same
narrative EVEN AFTER a recovery nudge."* RCA showed the model was **not** stuck
for lack of capability — its two code phases were done and tests passed. It was
stuck at the finalize step on a todo *"驗證合併 + architecture 同步 + 結 issue +
event 收尾"* (pure documentation bookkeeping), and three stacked defects trapped it:

1. **False gate.** `Todo.inferActionFromContent` (todo.ts:61-94) keyword-matches
   `architecture` / `refactor` / `schema` / `migration` in the todo *text* and
   stamps `action.kind=architecture_change`, `needsApproval=true`. The doc-chore
   todo matched on the word "architecture" — a false positive. The gate should
   not have existed.

2. **Dead config / advisory-only gate.** `AutonomousPolicy.requireApprovalFor`
   (`["push","destructive","architecture_change"]`, index.ts:196,427) is **never
   read or enforced**. `planAutonomousNextAction` (workflow-runner.ts:568-646)
   documents the stance explicitly (workflow-runner.ts:637-640): *"No pre-emptive
   gates. AI decides on blockers / approvals / questions itself … never silently
   gates work."* The whole gate is delegated to the model's self-judgment.

3. **A lock with no key.** The model can SEE `needsApproval=true` (it renders as
   a UI chip) but the runtime gives it **no primitive to request approval**. Its
   only options are barge through or voluntarily stop. Caught between "the flag
   says I need approval" and "I have no verb to ask for it," it dithered: each
   turn it re-announced intent, performed only the read-only sub-actions, hit the
   write it dared not make, and repeated. The paralysis detector's sole recovery
   — inject a synthetic "try a different path" text into the *same* model, *same*
   context, *same* tools (prompt.ts:2894-2960, selectParalysisNudge:468-483) — is
   structurally incapable of helping gate-induced dither, because the missing
   thing is a key, not advice. Nudge → still stuck → halt.

The deeper truth: **`harness/autonomous-opt-in` R5 already specifies this gate** —
*"R5 — Disarm on interruption. Any of: … blocker (approval / question tool /
error) … → immediately disarms autorun"* (autonomous-opt-in/proposal.md:55,
spec.md:114). The behavior was specified and never implemented. This is a
spec-vs-code divergence, not a new idea.

## Original Requirement Wording (Baseline)

Recorded from conversation 2026-06-21:

> 所以你打算怎麼修？我希望是架構級的重構處理，而不是局部補丁。
>
> [scope confirmed] 全做：廢假門+給鑰匙+runtime 守門。

## Requirement Revision History

- 2026-06-21: drafted from RCA of stuck session `ses_115cfbcf…`; scope confirmed
  = Option A (enforce gate + add request-approval primitive + remove keyword gate
  + paralysis defers to gates).
- 2026-06-22 (**PREMISE INVERSION**): user goal shifted to **retiring verbal-trigger
  autorun** (phased; Phase 1 = neutralize arm; freerun out of scope). This inverts
  the plan's core: DD-1/DD-2 made the arm gate runtime-owned *while keeping arming*
  — but with arming retired they fire inside `planAutonomousNextAction`, which
  early-returns `{stop, not_armed}` when `enabled===false` (workflow-runner.ts:610-611),
  so they become **unreachable dead code → SHELVED, not merged**. Only DD-3
  (false-gate removal, fires on every TodoWrite) + DD-4 (paralysis defers to gates,
  runs for all sessions) — the arm-independent, accident-necessary subset — merge to
  main. Added DD-6 (phased arm retirement), DD-7 (freerun out of scope), DD-8
  (arm-independent subagent-completion continuation, folds in new BR
  `issue_20260622_execution_mode_subagent_continuation_arm_gated`). See design.md
  Decisions DD-6/7/8 and the restructured tasks.md.

## Effective Requirement Description

1. The autonomous loop's approval gate must be **owned and enforced by the
   runtime**, not delegated to the model's self-judgment — implementing
   `autonomous-opt-in` R5.
2. The model must have a **first-class primitive to request approval / hand back
   to the user**, which deterministically suspends the session (the missing key).
3. The `architecture_change` gate must **stop being inferred from todo text** —
   the false-positive source. Real high-risk actions are gated where they
   actually occur (tool-permission time) or by the model's explicit declaration.
4. The paralysis detector must **defer to an active/suspended gate** — never
   treat gate-induced non-progress as paralysis to nudge-then-halt.

## Scope

### IN
- Enforce `requireApprovalFor` at `planAutonomousNextAction` (deterministic
  suspend → `waiting_user` + `stopReason=approval_required:<kind>`), reusing
  `NON_RESUMABLE_WAITING_REASONS`.
- A model-invokable "request approval / handback" signal (tool or reserved todo
  status) routed to the **existing** suspend machinery
  (`PermissionNext`/`Question` `RejectedError` → `waiting_user`).
- Remove `architecture_change` keyword inference from `inferActionFromContent`.
- Paralysis detector: skip / defer when the head todo is gate-blocked or the
  session is in a non-resumable `waiting_user` state.

### OUT
- No new approval **UI/transport** — reuse the existing question/permission
  prompt surface.
- No change to `push` / `destructive` gating at tool-permission time (already
  works); we only stop *inferring* them from todo prose where that double-gates.
- No change to the autonomous opt-in arming conditions (R1-R4 of autonomous-opt-in).
- Not touching the paralysis **detection** signals (tool-sig / narrative / preface
  / no-progress) — only their interaction with gates.

## Non-Goals

- Not making the model "smarter" about self-gating — the fix is structural
  (give it a key + let the runtime own the gate), not prompt tuning.
- Not removing the paralysis detector — it remains the backstop for genuine
  no-gate spin (e.g. the earlier specbase-routing loop in the same session).

## Constraints

- Reuse existing suspend primitives; do **not** invent a new subsystem (大道至簡).
- `~/.config/opencode/` must be backed up before the first code edit (repo CLAUDE.md).
- Daemon lifecycle only via `system-manager:restart_self` — no manual spawn/kill.

## What Changes

- `requireApprovalFor` becomes enforced runtime config instead of dead config.
- A new handback/request-approval verb suspends the session deterministically.
- `architecture_change` is no longer keyword-inferred from todo text.
- Paralysis recovery yields to gates.

## Capabilities

### New Capabilities
- **Request-approval / handback primitive**: model can deterministically suspend
  the autonomous loop pending user approval (the key R5 implied but never had).
- **Runtime-enforced approval gate**: `planAutonomousNextAction` suspends before
  entering a `requireApprovalFor` step.

### Modified Capabilities
- **Todo action inference**: drops `architecture_change` keyword rule; keeps
  push/destructive only where they map to real gated actions.
- **Paralysis recovery**: gate-aware — defers instead of nudging/halting a
  gate-blocked turn.

## Impact

- Code: `packages/opencode/src/session/workflow-runner.ts`, `todo.ts`,
  `tool/todo.ts`, `prompt.ts` (paralysis ~2590-2960), `index.ts`
  (`AutonomousPolicy`), possibly a new `tool/` entry for the handback verb.
- Specs: implements `harness/autonomous-opt-in` R5; cross-links
  `question-tool_idle-watchdog-false-kill` (sibling "false session kill" class).
- Tests: `workflow-runner.test.ts`, `session-autonomous.test.ts`,
  `model-orchestration.test.ts`, `prompt`/paralysis tests, `todo` tests.
- Operators: autonomous sessions will now visibly pause for approval instead of
  silently spinning then erroring.
