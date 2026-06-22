# Spec: harness_autonomous-gate-enforcement

## Purpose

Make the autonomous supervisor's approval gate real and survivable: owned and
enforced by the runtime, equipped with a model-invokable key, free of false
keyword-inferred gates, and immune to being mistaken for paralysis. Implements
`harness/autonomous-opt-in` R5 ("blocker → disarm autorun"), which is specified
but unenforced.

## Requirements

### Requirement: the runtime must enforce the approval gate, not delegate it to the model

The autonomous loop must own the gate; the model must never be resumed into a
step flagged for approval.

#### Scenario: actionable gated todo suspends instead of resuming
- **WHEN** the loop is about to re-stimulate the model into an actionable todo
  whose `action.kind ∈ AutonomousPolicy.requireApprovalFor`
- **THEN** it deterministically suspends (`state=waiting_user`,
  `stopReason=approval_required:<kind>`, non-resumable) and surfaces an approval
  prompt — it does NOT resume the model into the gated step.

#### Scenario: enforcement is idempotent with the tool-permission gate
- **WHEN** the step is already `blocked`/`waiting_user` from a tool-permission gate
- **THEN** the policy gate does NOT suspend a second time (no double-suspend).

#### Scenario: empty policy is genuinely live
- **WHEN** `requireApprovalFor=[]`
- **THEN** no suspend occurs — proving the config is read, not dead.

### Requirement: the model must have a first-class key to request approval

#### Scenario: awaiting_approval status routes to the suspend path
- **WHEN** the model sets a todo to the reserved status `awaiting_approval` via `TodoWrite`
- **THEN** the runtime routes it into the SAME suspend path as the policy gate
  (`waiting_user` + non-resumable `stopReason`), pausing pending user decision.

#### Scenario: user approval resumes continuation
- **WHEN** the user approves a suspended gate
- **THEN** the gate is cleared (`needsApproval=false` / grant recorded) and the
  loop resumes the model into the step.

### Requirement: documentation/bookkeeping work must not be falsely gated

#### Scenario: doc todo mentioning "architecture" is not gated
- **WHEN** a todo's text contains "architecture" / "refactor" / "schema" /
  "migration" but is not a genuinely gated action
- **THEN** `inferActionFromContent` does NOT stamp `architecture_change` /
  `needsApproval`; `push`/`destructive` inference is retained only where it maps
  to real gated actions.

### Requirement: the paralysis detector must defer to legitimate gates

#### Scenario: gate-induced non-progress is not paralysis
- **WHEN** a turn makes no progress because the head todo is `awaiting_approval`
  / approval-blocked, or the session is in a non-resumable `waiting_user` state
- **THEN** the paralysis detector does NOT count it toward the ladder and does
  NOT halt with `ParalysisDetectedError` — the clean suspend is the correct outcome.

#### Scenario: genuine no-gate spin still halts (backstop preserved)
- **WHEN** the model repeats identical failing tool calls with no gate active
- **THEN** the paralysis detector STILL detects and halts (no regression).

## Acceptance Checks

- A `requireApprovalFor` actionable todo → `waiting_user` + `approval_required`
  stopReason; the model is not resumed; no `ParalysisDetectedError`.
- Model sets `awaiting_approval` → same suspend; user approval → continuation resumes.
- `requireApprovalFor=[]` → no suspend (config genuinely live, not dead).
- A doc todo mentioning "architecture" → no `architecture_change`, no needsApproval.
- A gate-blocked turn → no paralysis halt; a real identical-tool-call spin → still halts.
