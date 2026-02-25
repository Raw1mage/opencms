# Event: Session project name readability

Date: 2026-02-25
Status: Done

## Decision

- `/session list` should not expose opaque `projectID` hashes as project labels.
- When explicit `project.name` is missing, fallback to repository folder name (derived from worktree/directory basename).

## Scope

- `packages/opencode/src/cli/cmd/session.ts`
  - table/json output now resolves readable project name from configured name or directory basename.
- `packages/opencode/src/cli/cmd/tui/component/dialog-session-list.tsx`
  - session label now uses project name fallback based on worktree/directory basename.
- `packages/opencode/src/project/project.ts`
  - `Project.fromDirectory()` initializes and backfills `project.name` from worktree basename when absent (except global project).

## Validation

- `bun run packages/opencode/src/index.ts session list --format table --max-count 3`
- `bun run packages/opencode/src/index.ts session list --format json --max-count 1`

Both outputs show `opencode` as readable project name instead of hash.
