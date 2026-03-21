# Design: Generic Branch Repo MCP CICD

## Context

- The repo already contains multiple stdio MCP packages under `packages/mcp/*`, with `packages/mcp/system-manager/src/index.ts` showing the current implementation style for local machine orchestration.
- The operator wants two concurrent local working directories for the same repo lineage: one beta area for feature editing and one main worktree for launching the project-specific dev runtime against that same feature branch.
- This repo has a special runtime policy requiring startup through `webctl.sh`, but the target MCP must generalize to different projects via a policy adapter layer.
- The user explicitly wants no hidden fallback mechanism, so clone mode, implicit path selection, and unsafe branch switching are all out of bounds.

## Goals / Non-Goals

**Goals:**

- Represent the feature loop as a deterministic local state machine over project context, git branch, worktree path, and runtime readiness.
- Implement the first slice as a self-contained MCP stdio package that can be enabled like existing MCP servers.
- Keep operations local-first and explicit: inspect, prepare, sync, run, finalize.
- Let AI infer or accept project context instead of hard-coding a single repo's branch names and runtime commands.
- Teach `beta-tool` to prefer structured clarification via `question` whenever context inference is ambiguous.

**Non-Goals:**

- Do not automate code edits in the beta worktree.
- Do not support two orchestration backends (worktree and independent clone) in the same first implementation.
- Do not guess project policy silently when context is ambiguous.
- Do not hide destructive confirmations in freeform text when `question` can present a bounded choice safely.

## Decisions

- **Use git worktree as the canonical topology**: one shared git object store with separate working directories best matches the need for simultaneous editing and runtime validation while avoiding branch push/pull churn between clones.
- **Implement as a standalone MCP package under `packages/mcp/branch-cicd`**: this matches existing package layout and keeps orchestration local to stdio MCP rather than adding new server routes prematurely.
- **Introduce project context resolution as a first-class step**: add `resolve_project_context` plus a `project-policy` adapter so branch naming, base branch, beta root, and runtime commands can come from explicit input or repo-aware inference.
- **Use explicit tool phases instead of a single opaque mega-command**: a small set of tools (`resolve_project_context`, `prepare_feature_loop`, `get_loop_status`, `sync_feature_to_main`, `start_main_runtime`, `finalize_feature_loop`) improves observability and fail-fast behavior.
- **Use `question` as the ambiguity and approval gateway**: bounded decisions such as branch naming, merge target selection, destructive confirmation, and runtime-policy choice should be surfaced through structured options instead of prose-only prompts.
- **Persist minimal local loop metadata**: store a small mapping file under XDG state or config so the MCP package can remember main-path/beta-path/branch relationships across sessions without inferring from arbitrary directories.
- **Treat merge/delete/removal as guarded sub-steps inside finalization**: the tool can support them, but it must require explicit confirmation flags and re-check safety before each destructive mutation.

## Data / State / Control Flow

- Operator invokes MCP tool with explicit project context or asks the MCP to resolve it from repo context.
- Project context resolution yields: repo root, base branch, branch naming strategy, beta-root policy, and runtime launcher policy.
- If context resolution yields multiple safe candidates, the MCP pauses and emits a `question` prompt with explicit choices.
- MCP inspects git state of the canonical main repo, current branch, dirty files, and existing worktrees.
- `prepare_feature_loop` creates or reuses a local feature branch and attaches a beta worktree path for that branch.
- The loop metadata layer records: canonical repo path, resolved base branch, main worktree path, beta worktree path, branch name, runtime policy, and last known runtime branch state.
- `sync_feature_to_main` validates the main worktree is clean enough, then checks out the feature branch in the main worktree so runtime validation uses the same branch lineage.
- `start_main_runtime` executes the runtime command chosen by the project policy adapter in the main worktree and returns stdout/stderr/exit status summary.
- If manual testing fails, the operator edits in beta worktree and re-runs sync + runtime start; no new branch/worktree is created.
- `finalize_feature_loop` verifies merge preconditions for the resolved base branch, checks out that base branch in the main worktree if safe, merges the feature branch, then optionally deletes the branch and removes the beta worktree.

## Risks / Trade-offs

- Dirty tree / branch mismatch can corrupt the operator workflow -> every transition begins with explicit git status checks and hard blockers.
- Worktree path collisions can damage unrelated directories -> require deterministic path construction plus preflight checks that the path is either absent or already a git worktree owned by the same repo.
- Ambiguous project policy can cause the wrong branch naming or runtime command -> resolve context explicitly and error when inference is not confident enough.
- Overusing automation can make the tool feel opaque -> mitigate by standardizing interactive checkpoints through `question` with short option labels and clear descriptions.
- Merge conflicts may stall the "one-click" idea -> first slice stops and reports conflicts instead of attempting automated conflict resolution.
- Worktree-only design excludes users who truly need separate clones -> accepted for v1 because it is simpler, safer, and directly matches the clarified requirement.
- Metadata persistence introduces another state source -> keep it minimal and cross-check against live git state so metadata is advisory, not authority.

## Critical Files

- `packages/mcp/branch-cicd/src/index.ts`
- `packages/mcp/branch-cicd/src/context.ts`
- `packages/mcp/branch-cicd/src/project-policy.ts`
- `packages/mcp/system-manager/src/index.ts`
- `webctl.sh`
- `packages/opencode/src/session/prompt/enablement.json`
- `templates/prompts/enablement.json`
- `specs/architecture.md`
- `docs/events/event_20260321_branch_repo_mcp_cicd.md`

## Supporting Docs (Optional)

- `docs/events/event_20260320_mcp_unix_socket_ipc.md`
- `docs/events/event_20260223_web_dev_branch_realign_and_picker_fix.md`
