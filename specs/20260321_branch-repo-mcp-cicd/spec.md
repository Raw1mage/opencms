# Spec: beta-tool Generic Branch Workflow MCP

## Purpose

- Define the observable behavior of a project-aware worktree-based MCP workflow that lets the operator iterate between beta editing and main-worktree runtime verification for the same feature branch across different repositories.

### Requirement: Project context resolution

The system SHALL resolve or validate project context before mutating git or runtime state.

#### Scenario: infer project policy from current repo context

- **GIVEN** the operator does not explicitly provide base branch, branch naming policy, beta root, or runtime command
- **WHEN** the operator invokes context resolution or another loop tool
- **THEN** the system inspects available repo context and returns the resolved project policy or an explicit ambiguity error

#### Scenario: ambiguous context requires interactive clarification

- **GIVEN** multiple plausible base branches, beta roots, or runtime commands exist
- **WHEN** the system cannot safely choose one from context
- **THEN** the system uses the `question` tool to present bounded options and does not proceed until the ambiguity is resolved

## Requirements

### Requirement: newbeta bootstrap

The system SHALL let `newbeta` create or attach a beta worktree for a requested feature branch starting from the resolved current authoritative branch without mutating the main worktree unexpectedly.

#### Scenario: create a new feature loop

- **GIVEN** the canonical repo has a clean base-branch worktree
- **WHEN** the operator invokes the bootstrap tool with a new branch name or asks the system to derive one from context
- **THEN** the system creates the local feature branch from the resolved base branch, attaches a beta worktree for that branch, and returns both the main and beta paths as explicit outputs

#### Scenario: branch naming needs user selection

- **GIVEN** the system can derive more than one reasonable branch name pattern from context
- **WHEN** `newbeta` is requested without an explicit branch name
- **THEN** the system uses the `question` tool to offer candidate branch names or naming styles before creating the branch

#### Scenario: reuse an existing feature loop

- **GIVEN** the requested feature branch and beta worktree already exist
- **WHEN** the operator invokes the bootstrap tool again
- **THEN** the system reuses the existing mapping instead of creating duplicates and reports the current loop status

### Requirement: syncback main worktree checkout

The system SHALL let `syncback` make the main repo worktree explicitly switch to the same feature branch used by the beta worktree.

#### Scenario: sync feature branch into main worktree

- **GIVEN** a beta worktree already exists for a feature branch
- **WHEN** the operator invokes the sync/check-out tool
- **THEN** the system verifies the main worktree is safe to switch, checks out the feature branch in the main worktree, and reports any dirty-tree blocker instead of forcing the checkout

### Requirement: syncback preserves runtime readiness

The system SHALL make the main repo ready for manual testing through the resolved project policy entrypoint after `syncback`.

#### Scenario: start manual verification runtime after syncback

- **GIVEN** the main worktree is on the target feature branch
- **WHEN** the operator invokes `syncback` and then starts testing
- **THEN** the system has switched the main worktree to the feature branch and returns the resolved runtime command or executes it according to the final tool contract

### Requirement: Loop status is explicit and fail-fast

The system SHALL expose branch/worktree/runtime state explicitly and refuse ambiguous or unsafe transitions.

#### Scenario: dirty working tree blocks transition

- **GIVEN** either the main or beta worktree contains uncommitted changes that would make the next step unsafe
- **WHEN** the operator requests checkout, merge, delete, or worktree removal
- **THEN** the system rejects the action with a structured blocker message and does not perform a fallback or partial mutation

### Requirement: merge requires explicit approval and explicit resolution

The system SHALL keep `merge` behind an explicit operator-approved destructive step and must expose the resolved target branch before execution.

#### Scenario: merge a verified feature branch

- **GIVEN** manual verification has succeeded and the operator confirms finalization
- **WHEN** the operator invokes `merge`
- **THEN** the system reports the AI-resolved target branch, requires confirmation, merges the feature branch into that branch if safe, and reports each sub-step result

#### Scenario: merge target is inferred but not certain enough

- **GIVEN** the system sees multiple plausible authoritative branches
- **WHEN** `merge` is requested
- **THEN** the system uses the `question` tool to present candidate targets and does not execute the merge until the user selects one

## Acceptance Checks

- Project context can be provided explicitly or inferred with an auditable resolved-policy payload.
- Creating a disposable feature branch with `newbeta` yields a deterministic beta worktree path and a stable status payload.
- Attempting to switch the main worktree while dirty returns a blocker instead of changing branches.
- `syncback` returns enough runtime policy information for the operator to run the correct project test flow.
- Re-entering the loop after failed manual verification preserves the same feature branch and worktree mapping.
- `merge` refuses to execute without explicit confirmation, exposes the resolved target branch, and refuses cleanup while blockers remain.
- Ambiguous branch naming, beta-root choice, runtime policy, or merge target causes a `question`-driven clarification step instead of silent guessing.
