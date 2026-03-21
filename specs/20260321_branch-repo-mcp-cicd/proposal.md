# Proposal: beta-tool Generic Branch Workflow MCP

## Why

- The operator needs to keep two working directories alive at the same time across different projects: one for active feature editing and one for running the main dev runtime against the same feature branch.
- Manual branch switching inside one working directory is too fragile for this workflow because running the web server and editing code compete for the same checkout.
- A dedicated MCP server can make the loop repeatable and one-command friendly without introducing hidden git fallbacks, while still letting AI infer project-specific branch names and runtime commands from context.

## Original Requirement Wording (Baseline)

- "由於不同branch需要不同repo才能同時存在，我想要一個MCP來幫我處理一鍵CICD的開發調試流程。"
- "1. based on main repo cms branch, 在beta開new branch然後改程式。"
- "2. beta new branch改好後把new branch \"同步\"回來main repo，讓main repo 也擁有new branch。"
- "3. main repo切換到new branch去啟動web server，測試新功能。"
- "4. 測試有問題，就去beta改，然後循環1-3。"
- "5. 測試成功，main repo new branch就merge回cms，然後刪除new branch。"

## Requirement Revision History

- 2026-03-21 planning clarification: operator asked what worktree means and whether two branches can be used simultaneously.
- 2026-03-21 planning decision: choose a worktree-based topology (preferred over separate clones) so beta editing and main runtime validation can coexist safely.
- 2026-03-21 planning decision: automation level is semi-automatic — MCP performs setup/sync/runtime orchestration, but merge and cleanup remain approval-gated.
- 2026-03-21 planning decision: validation target is manual verification after starting the web runtime from the main worktree.
- 2026-03-21 requirement expansion: MCP should be reusable across projects, so branch naming, worktree root, base branch, and runtime entrypoint must be context-aware instead of hard-coded.

## Effective Requirement Description

1. Build a generic MCP server named `beta-tool` that manages a local git-worktree development loop for different projects, where a beta worktree is used to edit a feature branch and the main worktree is used to run and manually verify that same branch.
2. The MCP server MVP must expose 3 public tools: `newbeta`, `syncback`, and `merge`.
3. The workflow must support repeated edit-test iterations without recreating the branch or losing track of the beta/main worktree mapping.
4. The workflow must fail fast on dirty trees, path conflicts, ambiguous project policy, and ambiguous branch/worktree state; it must not add clone fallback or implicit branch selection.
5. `merge` may use AI to resolve the authoritative target branch from context, but it must surface that resolution explicitly and require confirmation before executing destructive steps.
6. `beta-tool` should actively use the `question` tool to resolve ambiguous context, branch naming, target selection, and destructive-operation approval instead of relying on prose-only guessing.

## Scope

### IN

- A new MCP package for generic local branch/worktree orchestration under the capability name `beta-tool`.
- Worktree creation, inspection, and guarded removal.
- Local branch creation and visibility across worktrees.
- Main worktree checkout plus project-aware runtime start/refresh commands.
- Approval-gated merge into the resolved authoritative branch and cleanup of temporary feature assets.
- Enablement/documentation updates required to make the capability discoverable.

### OUT

- Editing source code automatically in the beta worktree.
- Remote push/PR workflows.
- Browser automation for feature verification.
- Converting the whole project to a remote CI system.

## Non-Goals

- Not replacing git with a higher-level abstraction; the MCP package remains a guarded orchestrator over explicit git/worktree commands.
- Not auto-resolving merge conflicts.
- Not supporting both worktree mode and multi-clone mode in the first slice.

## Constraints

- Must support project-specific runtime policies while preserving this repo's rule that web runtime is started only via `./webctl.sh dev-start` or `./webctl.sh dev-refresh`.
- Must not introduce silent fallback mechanisms.
- Must keep merge/delete operations behind explicit operator intent.
- Should align with existing MCP package style under `packages/mcp/*` and existing stdio server patterns.

## What Changes

- Add a new MCP server package dedicated to generic branch/worktree local development orchestration, exported as `beta-tool`.
- Introduce a formal state model for `base-branch main worktree` ↔ `feature beta worktree` lifecycle.
- Introduce a project-context/policy layer so AI can decide branch naming and runtime entrypoints from current repo context.
- Extend enablement metadata so the new MCP capability is discoverable to agents/operators.
- Add docs/event records describing the branch loop and its fail-fast boundaries.

## Capabilities

### New Capabilities

- `newbeta`: create a beta worktree and new feature branch from the current authoritative branch in the main repo context.
- `syncback`: switch the main repo to the feature branch so the operator can run tests with the project's runtime command.
- `merge`: merge the feature branch into the AI-resolved authoritative branch after showing that resolution and receiving confirmation.
- Internal context resolution: infer repo root, authoritative branch, beta-root policy, and runtime launch policy from project context.
- Structured clarification via `question`: when context is ambiguous, ask bounded multiple-choice questions before acting.

### Modified Capabilities

- MCP capability registry / enablement metadata: gains explicit `beta-tool` discoverability.

## Impact

- Affects local operator workflow for feature development across multiple git projects.
- Adds a new MCP package under `packages/mcp/`.
- Updates architecture/event/enablement docs to represent worktree-driven branch orchestration.
