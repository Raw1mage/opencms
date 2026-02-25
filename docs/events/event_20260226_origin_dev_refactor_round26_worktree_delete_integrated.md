# Event: origin/dev refactor round26 (worktree delete)

Date: 2026-02-26
Status: In Progress

## 1) Goal

Continue value-driven rewrite-only upstream sync by evaluating `fix(app): worktree delete` for cms compatibility and deciding port/integrated/skip.

## 2) Candidate

- Upstream commit: `8da5fd0a66b2b31f4d77eb8c0949c148b9a7d760`
- Subject: `fix(app): worktree delete`

## 3) Decision + rationale

- Decision: **Integrated**
- Rationale:
  - Current cms `Worktree.remove()` already contains the same defensive behavior:
    - parse+locate worktree from porcelain output,
    - tolerate `git worktree remove` non-zero when worktree is already detached,
    - verify stale entry before failing,
    - force-clean residual directory with retry,
    - delete branch after cleanup.
  - Upstream regression test is also already present in cms test tree.

## 4) File scope reviewed

- `packages/opencode/src/worktree/index.ts`
- `packages/opencode/test/project/worktree-remove.test.ts`

## 5) Validation plan / result

- Validation method: source-vs-current diff comparison for behavior parity.
- Result: integrated-equivalent behavior confirmed; no code port required.

## Architecture gate

- Checked `docs/ARCHITECTURE.md` before deciding execution.
- No architecture boundary/semantic change; no architecture doc update required.
