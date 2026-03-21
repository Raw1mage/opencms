# Event: Generic Branch Repo MCP CICD Planning

**Date**: 2026-03-21
**Status**: Implemented

---

## Requirement

User requested an MCP that can orchestrate a one-key local development/test loop where:

1. Based on the main repo `cms` branch, create a new feature branch in a beta repo/work area and edit there.
2. Sync the new branch back so the main repo also has that branch.
3. Switch the main repo to that new branch, start the web server, and test the feature.
4. If testing fails, continue editing in beta and repeat the cycle.
5. If testing succeeds, merge the main repo feature branch back into `cms` and delete the feature branch.

Follow-up clarification expanded the requirement: this MCP should be reusable across different projects, so worktree configuration, base branch, branch naming, and runtime command must be decided from current context rather than hard-coded per project.

## Scope

### IN

- Plan a dedicated MCP package for generic local branch/worktree orchestration.
- Model a beta editing worktree and a main runtime worktree.
- Define the prepare → sync → runtime-start → retry → finalize loop.
- Define project-context resolution for repo root, base branch, branch naming, beta path policy, and runtime policy.
- Define fail-fast and approval gates for destructive operations.

### OUT

- Remote CI/CD providers and PR automation.
- Automatic code editing.
- Browser automation.
- Multi-clone fallback design in v1.

## Task List

- Define the project-aware worktree-based operator topology and state machine.
- Define MCP tool surface and fail-fast boundaries.
- Align planner artifacts: proposal/spec/design/tasks/handoff/diagrams.
- Record architecture sync status.

## Dialogue Summary

- User asked whether worktree allows two branches at once and whether one can be used for editing while the other runs.
- Clarified that `git worktree` supports multiple simultaneous working directories for the same repository object store.
- User selected semi-automatic orchestration and manual verification.
- Planning concluded that worktree is better than maintaining two separate clones for the requested loop.
- User then clarified that the MCP should be generic across projects, and AI should decide worktree setup and branch naming based on current context.
- User additionally requested teaching `beta-tool` to make good use of the `question` tool for user interaction.

## Debug / Planning Checkpoints

### Baseline

- Need: simultaneous feature editing and runtime validation against the same branch lineage.
- Constraint: this repo's web runtime must start only via `webctl.sh`, but the MCP itself must generalize through a project-policy layer.
- Constraint: no silent fallback mechanisms.

### Instrumentation / Evidence Plan

- Read `specs/architecture.md` for repo runtime and workdir constraints.
- Read existing MCP event docs for implementation style and routing context.
- Inspect current MCP package structure under `packages/mcp/*`.

### Evidence Gathered

- `packages/mcp/system-manager/src/index.ts` is the current primary example of a local stdio MCP orchestrator.
- `docs/events/event_20260320_mcp_unix_socket_ipc.md` confirms current MCP work is package-based and local-runtime aware.
- `docs/events/event_20260223_web_dev_branch_realign_and_picker_fix.md` provides precedent for separate dev work directories.

### Root Decision

- Use **git worktree** as the v1 topology.
- Build a standalone MCP package under `packages/mcp/branch-cicd`.
- Add a **project-context / policy adapter** layer so repo root, base branch, branch naming, beta root, and runtime command can be inferred or provided explicitly.
- Keep merge/delete/remove behind explicit approval gates.
- Use the `question` tool as the standard bounded-choice interface for ambiguity resolution and destructive confirmation.

## Key Decisions

1. **Topology**: worktree-only for v1, not dual support for clone mode.
2. **Automation posture**: semi-automatic; final merge/cleanup remain approval-gated.
3. **Validation**: manual web verification from the main worktree.
4. **Genericity**: repo root, base branch, branch naming, beta path, and runtime command must be context-aware rather than hard-coded.
5. **Runtime policy**: this repo still uses `./webctl.sh dev-start` / `./webctl.sh dev-refresh`, but that is an adapter rule, not the universal default.
6. **Safety policy**: dirty tree, path collision, branch ambiguity, project-policy ambiguity, and merge conflicts are hard blockers.
7. **Interaction policy**: `beta-tool` should prefer `question` for bounded decisions such as candidate branch name, merge target, beta path disambiguation, and destructive confirmation.

## Validation

- Planner artifacts updated:
  - `specs/20260321_branch-repo-mcp-cicd/implementation-spec.md`
  - `proposal.md`
  - `spec.md`
  - `design.md`
  - `tasks.md`
  - `handoff.md`
  - `idef0.json`
  - `grafcet.json`
  - `c4.json`
  - `sequence.json`
- Architecture Sync: Verified (No doc changes)
  - Basis: current plan adds a new MCP package/workflow but does not yet change implemented runtime module boundaries in the codebase.

## Implementation Checkpoints

- Added `packages/mcp/branch-cicd` as a standalone stdio MCP package exported publicly as `beta-tool`.
- Implemented project-context resolution in `packages/mcp/branch-cicd/src/context.ts`.
- Implemented runtime-policy and git/worktree helpers plus XDG loop metadata persistence in `packages/mcp/branch-cicd/src/project-policy.ts`.
- Implemented public tools `newbeta`, `syncback`, and `merge` in `packages/mcp/branch-cicd/src/beta-tool.ts` and registered them in `src/index.ts`.
- Implemented structured orchestrator-question contracts for branch naming, runtime-policy ambiguity, merge-target ambiguity, and destructive merge confirmation.
- Synced enablement metadata and architecture notes for beta-tool discoverability.
- Wired repo runtime integration so internal MCP source-mode now recognizes `beta-tool` and rewrites it to `packages/mcp/branch-cicd/src/index.ts` from config like other repo-tracked internal MCP servers.
- Added repo-tracked config templates for `beta-tool` under `templates/opencode.json` and `templates/examples/project-opencode/opencode.jsonc` with `enabled: false` default so capability is discoverable without forcing it resident.

## Validation Snapshot

- `bun x tsc --noEmit --project packages/mcp/branch-cicd/tsconfig.json` ✅
- `bun x tsc --project packages/mcp/branch-cicd/tsconfig.json` ✅
- `bun packages/mcp/branch-cicd/src/index.ts` starts successfully and emits `beta-tool running on stdio` ✅
- Safe local dry-run / temporary-repo validation completed:
  - `newbeta` branch-name ambiguity returns `needs_question` ✅
  - `newbeta` create loop succeeds on disposable repo ✅
  - `syncback` same-branch dual-worktree checkout succeeds ✅
  - `merge` preflight returns `needs_confirmation` ✅
  - confirmed `merge` succeeds on disposable repo ✅
  - dirty tree returns `blocked` ✅
  - foreign worktree collision returns `blocked` ✅
- Architecture Sync: Updated
  - `specs/architecture.md` now documents the `beta-tool` MCP architecture surface and its question-driven fail-fast contract.

## Remaining

- Current session/runtime still requires a local non-repo config change to actually enable the MCP by default: add `mcp["beta-tool"]` to `~/.config/opencode/opencode.json` (or project `opencode.json[c]`) and set `enabled: true`, reusing command `['bun', 'packages/mcp/branch-cicd/src/index.ts']`.
