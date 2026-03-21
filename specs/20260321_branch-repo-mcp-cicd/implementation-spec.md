# Implementation Spec

## Goal

- Build a project-aware MCP server named `beta-tool` that provides a minimal 3-tool worktree workflow across different repositories: `newbeta`, `syncback`, and `merge`.

## Scope

### IN

- Create a dedicated MCP package for generic branch/worktree orchestration under the public capability name `beta-tool`.
- Model two local working directories per project: a stable main worktree and a beta worktree used for editing a feature branch.
- Allow AI or caller-provided context to determine repo root, default base branch, feature branch naming, beta root location, and runtime launch policy.
- `newbeta`: create a new branch based on the current main repo branch onto the beta repo/worktree for development.
- `syncback`: make the main repo switch to that new branch so the operator can run tests.
- `merge`: merge the new branch back into the branch the system resolves as the current authoritative mainline for that project/repo context.
- Support iterative re-entry after failed manual verification without losing branch/worktree mapping.
- Support operator-confirmed completion flow: merge feature branch back to the resolved target branch and optionally clean up the temporary beta worktree/branch.
- Support project-specific runtime policy adapters, including but not limited to this repo's `./webctl.sh dev-start` / `./webctl.sh dev-refresh` contract.

### OUT

- Remote CI providers, GitHub Actions, or cloud deployment pipelines.
- Automatic code editing inside the beta worktree; MCP orchestrates git/worktree/runtime operations only.
- Silent fallback from one repo/worktree/path to another.
- Automatic destructive merge without explicit operator confirmation.
- Hard-coding `cms`, `webctl.sh`, or any single project's branch naming convention as the universal behavior.

## Assumptions

- `git worktree` is the preferred topology over maintaining two fully independent clones.
- The MCP caller may provide explicit project context, but the server should also support context inference from the current repo and its policies.
- A beta worktree can live under a configurable sibling path, a policy-defined path template, or an operator-approved directory.
- Manual browser verification is the primary acceptance mechanism; automated tests are optional follow-up, not the release gate for this plan.
- Branch sync should remain local-first: the goal is to make both worktrees aware of the same local branch, not to push to remote by default.

## Stop Gates

- Stop if the operator wants independent clone-based repos instead of worktrees; that requires a different sync model.
- Stop if the desired beta worktree root path is unavailable or conflicts with an existing non-worktree directory.
- Stop before any destructive action: branch deletion, worktree removal, or merge execution.
- Stop if the current base-branch worktree or target feature branch has uncommitted changes that would be overwritten.
- Stop if AI cannot confidently resolve the authoritative merge target branch from current context.
- Stop and re-enter planning if the implementation needs server-side API exposure in `packages/opencode/src/server/routes/mcp.ts` instead of a pure stdio MCP package.

## Critical Files

- `packages/mcp/branch-cicd/src/index.ts`
- `packages/mcp/branch-cicd/package.json`
- `packages/mcp/branch-cicd/tsconfig.json`
- `packages/mcp/branch-cicd/src/project-policy.ts`
- `packages/mcp/branch-cicd/src/context.ts`
- `packages/mcp/branch-cicd/src/beta-tool.ts`
- `packages/opencode/src/session/prompt/enablement.json`
- `templates/prompts/enablement.json`
- `webctl.sh`
- `specs/architecture.md`
- `docs/events/event_20260321_branch_repo_mcp_cicd.md`

## Structured Execution Phases

- Phase 1 — Define the project-aware operator model, context inference contract, branch lifecycle, and `beta-tool` surface.
- Phase 2 — Implement the MCP package with explicit state inspection, project policy adapters, and non-fallback git/worktree/runtime commands behind `newbeta`, `syncback`, and `merge`.
- Phase 3 — Validate the full loop locally against this repo while keeping the package generic: infer project context, create feature branch, attach beta worktree, sync/switch main worktree, start project runtime, and exercise merge/cleanup dry run or guarded execution.
- Phase 4 — Sync enablement/docs/event records and verify architecture impact.

## Validation

- `bun x tsc --noEmit --project packages/mcp/branch-cicd/tsconfig.json`
- Repo-level build/test command for the new MCP package if the workspace exposes one.
- Manual dry-run verification on a disposable branch name proving:
  - `newbeta` creates or reuses the beta worktree deterministically,
  - project context can be provided explicitly or inferred from the working repo,
  - `syncback` makes the main worktree see and checkout the same branch,
  - project runtime launch obeys the selected policy adapter after `syncback`,
  - failed manual verification can return to beta edits without corrupting branch/worktree state,
  - `merge` returns the resolved target branch, requires explicit confirmation, and refuses when the tree is dirty.
- Negative-path validation proving fail-fast behavior when paths are missing, branch names collide, or uncommitted changes block checkout/merge.

## Handoff

- Build/implementation agent must read this spec first.
- Build/implementation agent must read all companion artifacts, especially `design.md`, `tasks.md`, and the worktree state machine diagrams, before coding.
- Runtime todo must be materialized from `tasks.md` before coding begins.
- Use explicit command wrappers and structured errors; do not add silent fallback to clone mode, alternate paths, implicit branch selection, or guessed project policy.
- Treat `merge`, branch delete, and worktree removal as approval-gated operations even if the MCP package supports them.
- At completion time, review implementation against the proposal's effective requirement description and update architecture/event docs in the same session.
