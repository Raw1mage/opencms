---
name: beta-workflow
description: Builder-driven beta worktree execution contract for approved build-mode runs. Use when mission metadata or build-mode execution indicates beta-enabled workflow, beta branch fetch-back/finalize/remediation steps, or when implementation must stay off the authoritative main repo/base branch.
---

# Beta Workflow

This skill is a hard execution contract, not a suggestion layer.

Do not implement from the authoritative `mainRepo` / `baseBranch`.

## 0. Why this contract is strict

- `main` history already shows at least one confirmed mainline overwrite/drift event and multiple probable reset/rollback events.
- The repeated failure pattern is consistent: stale `beta/*`, `test/*`, or worktree execution surfaces were left alive, then later treated as if they were the authoritative mainline surface.
- The failure to prevent is simple: **implementation branch/worktree must never be mistaken for the authoritative main repo / base branch**.

If the authority surface is unclear, mismatched, or missing, stop immediately. Do not continue with defaults, memory, or fallback guesses.

## 1. Authority SSOT (must be restated from mission metadata)

Before any beta execution, validation, fetch-back, finalize, merge, cleanup, or remediation step, restate the exact mission-backed authority fields (including mission.beta context):

- `mainRepo`
- `baseBranch`
- `implementationRepo`
- `implementationWorktree`
- `implementationBranch`
- `docsWriteRepo`

Interpretation:

- `mainRepo` = authoritative git repo for the product line; this is a filesystem path that **owns the `.git` directory** and is where `baseBranch` is checked out by default. Do not call this a "main worktree" — in most repo layouts the main repo IS the default working tree, and attached `git worktree` entries are the non-main ones.
- `baseBranch` = authoritative branch that receives final history.
- `implementationRepo` / `implementationWorktree` / `implementationBranch` = disposable beta execution surface only. `implementationWorktree` is a real `git worktree add`-attached path that shares `.git` with `mainRepo`.
- `docsWriteRepo` = authoritative repo path for `/specs` and `docs/events` (often equal to `mainRepo` in single-repo projects).

Non-negotiable rules:

1. `implementationBranch` is never the same concept as `baseBranch`.
2. `implementationWorktree` path is never the same path as `mainRepo` unless mission metadata explicitly says the workflow is not beta-based.
3. `docsWriteRepo` remains authoritative even when implementation occurs elsewhere.
4. If any authority field is absent, contradictory, or inferred only from memory, stop.

### 1.1 User-facing terminology (critical)

When talking to the user, to commit messages, to event logs: translate schema field names into plain terms.

| Schema field | Say in conversation |
|---|---|
| `mainRepo` | "main repo" or "the main repo path" |
| `implementationRepo` | usually same path as `implementationWorktree`; say "beta worktree" |
| `implementationWorktree` | "beta worktree" (or the specific path, e.g. `opencode-beta`) |
| `implementationBranch` | the actual branch name, e.g. `beta/<feature>` |
| `baseBranch` | the actual branch name, usually `main` |
| `docsWriteRepo` | "main repo" when equal to `mainRepo`; otherwise name it |

**Never say "main worktree" in conversation.** It confuses users whose `mainRepo` is a plain repo with no separate main worktree concept. Keep `mainWorktree`-style language in internal schema reasoning only, and even there prefer `mainRepo` — they are the same path in typical layouts.

## 2. Disposable Surface Rule

`beta/*` and `test/*` branches, plus their worktrees, are disposable execution surfaces.

- They exist only to isolate implementation and validation.
- They are not authority sources.
- They are not merge targets by default.
- They are not safe fallback branches.
- They must not survive as long-lived shadow mainlines.

Never treat a beta/test branch as the product's current truth just because it contains newer-looking work.

## 3. Admission Gate (mandatory before work starts)

Before writing code or running beta validation, the AI must verify all of the following:

1. The authority fields in §1 are explicitly available from mission metadata.
2. The current repo/worktree/branch matches `implementationRepo`, `implementationWorktree`, and `implementationBranch`.
3. The authoritative surface is separately known as `mainRepo` / `baseBranch`.
4. The implementation branch originated from the intended authoritative base, not from a stale beta/test branch.

If any check fails:

- stop immediately
- report the mismatch precisely
- do not start implementation
- do not silently switch to another repo/worktree/branch

## 4. Forbidden Actions / Red Flags

The following are forbidden:

1. Treating `implementationBranch` as `baseBranch`.
2. Guessing the main branch name (`main`, `master`, etc.) without mission evidence.
3. Using a stale `beta/*` or `test/*` branch as the source of truth for fetch-back, finalize, or mainline recovery.
4. Continuing after an authority mismatch by using fallback/default branch names.
5. Implementing directly in `mainRepo` during a beta-enabled run.
6. Repointing, resetting, or otherwise moving the authoritative main branch toward a beta/test execution surface.
7. Declaring success while disposable beta/test branches or worktrees remain uncleared.
8. Using the phrase "main worktree" in conversation, commits, or event logs (see §1.1).

If a step would require any forbidden action, stop and escalate instead of improvising.

## 5. Canonical Workflow

The workflow is always:

1. **Admission**
   - Restate all authority fields.
   - Verify current surface equals the admitted implementation surface.
   - Verify authoritative mainline fields are separate and explicit.

2. **Execute in beta**
   - Implement only in `implementationWorktree` on `implementationBranch`.
   - Keep `/specs` and `docs/events` anchored to `docsWriteRepo` / authoritative repo.

3. **Validate**
   - Run validation from the builder-provided beta path.
   - If runtime policy requires fetch-back or mainline-side validation, do exactly that path and no invented substitute.

4. **Fetch-back / Finalize**
   - Restate the authority fields again before any fetch-back, checkout, merge, or finalize operation.
   - Fetch-back procedure (concrete steps):
     1. Switch to `mainRepo` (the authoritative repo path).
     2. Create a `test/<feature-name>` branch from `baseBranch` and checkout it.
     3. Merge `implementationBranch` into the test branch (the beta branch is reachable because both are in the same `.git` via worktree).
     4. Run validation / tests on the test branch.
     5. If validation passes, the test branch is ready for finalize (merge to `baseBranch`).
   - The test branch is disposable — it exists only to validate before touching `baseBranch`.
   - Treat merge/finalize as separate approval-gated steps.

5. **Cleanup + Spec Closeout**
   - Delete the disposable `beta/*` or `test/*` branch after merge/fetch-back/finalize succeeds.
   - Remove the disposable beta worktree (if it was created fresh for this run; `/home/pkcs12/projects/opencode-beta` and similar permanent workspaces are NOT removed — only the branch).
   - After the final `test/*` branch merge into `baseBranch` succeeds, close the completed spec package by promoting its durable content into the related semantic `/specs/` family inside `docsWriteRepo` (plan-builder handles this via `plan-promote --to living`).
   - If no unambiguous target semantic `/specs/` family can be identified, stop and request an explicit user decision before any promotion write; do not create an isolated fallback spec root.
   - If cleanup or spec closeout did not happen, the workflow is not complete.

6. **Verify mainline**
   - Confirm the authoritative repo/branch is still `mainRepo` / `baseBranch`.
   - Confirm the final intended commits are reachable from the authoritative branch.
   - Confirm the relevant semantic `/specs/` family now contains the finalized planning/spec knowledge for the completed workflow.

## 6. Drift / Divergence Handling

If the authoritative base branch advances while beta work is in progress:

1. Detect the drift explicitly.
2. Stop before validation/finalize if the mission policy requires remediation.
3. For shared long-lived branches (`main`/`beta`), rebase-based history rewrite is forbidden.
4. Perform remediation only against the authoritative base branch via merge, never against another stale beta/test surface.

If conflicts occur during remediation, stop and report them. Do not force-resolve or silently continue on the old base.

### 6.1 Dual-Update Merge Rule (`main=A+C`, `beta=B+D`)

When both branches have progressed independently:

- `main`: `A + C`
- `beta`: `B + D`
- required final shape: `A + C + D` (where `D` is rebuilt on top of `C`)

Non-negotiable merge policy:

1. Treat `main` as the authority for conflict precedence.
2. Sync `beta` from `main` using merge (not rebase).
3. If `C` vs `D` conflicts happen, keep `C` first, then manually refactor/re-apply `D`.
4. Never use rebase to replay stale `D` over authoritative `C` on shared branches.

Git command contract (example):

```bash
# Step 1: bring authoritative main into beta
git fetch origin
git switch beta
git merge origin/main

# Step 2: on conflict, keep main(C) as baseline, then refactor D manually
# (resolve files, run tests, commit merge)

# Step 3: fail-fast gate
# if conflicts unresolved or tests fail: STOP (no push / no finalize)

# Step 4: after beta is green, merge beta back to main
git switch main
git merge --no-ff origin/beta
```

Fail-fast gate:

- Any unresolved conflict => stop.
- Any failed validation/test => stop.
- Do not proceed to fetch-back/finalize/mainline merge until both are cleared.

## 7. Fetch-Back / Finalize Contract

Fetch-back means the authoritative repo imports the implementation branch for validation or finalize preparation. It does **not** mean the implementation branch became authoritative.

### 7.1 Fetch-back procedure

```bash
# 1. Switch working directory into the main repo path
cd $mainRepo

# 2. Create test branch from baseBranch
git checkout $baseBranch
git checkout -b test/$featureName

# 3. Merge implementation branch (reachable via shared .git)
git merge $implementationBranch
# On conflict: STOP and report. Do not force-resolve.

# 4. Validate on test branch
bun test   # or project-specific validation

# 5. If green → ready for finalize (merge test branch to baseBranch)
```

### 7.2 Pre-conditions

Before fetch-back or finalize:

1. Restate all authority fields from §1.
2. Confirm the source is `implementationRepo` / `implementationBranch`.
3. Confirm the destination authority is `mainRepo` / `baseBranch`.
4. Confirm the merge target was provided by mission metadata or explicit user approval.

If any of those are ambiguous, stop.

### 7.3 Finalize (test → baseBranch)

After fetch-back validation passes:

```bash
cd $mainRepo
git checkout $baseBranch
git merge --no-ff test/$featureName
# test branch is now merged — proceed to cleanup (§8)
```

This is approval-gated: do not finalize without explicit user confirmation.

## 8. Cleanup Is Part of Completion

Completion requires all of the following:

1. Implementation/validation/finalize finished on the correct surfaces.
2. The authoritative branch remains the authority.
3. The intended commits are present on the authoritative branch.
4. Disposable `beta/*` / `test/*` branch refs are deleted unless the user explicitly approved temporary retention.
5. Disposable beta worktree is removed — **only if it was created fresh for this run**. Permanent beta workspaces (e.g. `~/projects/opencode-beta`) are kept; only the branch is deleted.
6. The completed spec package has been promoted `verified → living` via plan-builder in `docsWriteRepo`.

Do not mark the workflow complete while stale beta/test execution surfaces remain live by accident or while completed planning artifacts are still stranded mid-lifecycle after the final mainline merge.

## 9. Stop Conditions

Stop immediately when:

- any authority field is missing or mismatched
- current worktree/branch does not match the admitted implementation surface
- main branch name is being inferred instead of read from metadata
- a stale beta/test branch is proposed as an authority source
- cleanup would be skipped
- the target semantic `/specs/` family for post-merge closeout is ambiguous
- a destructive corrective action would be needed without approval

The correct response is fail-fast with explicit mismatch evidence, not graceful fallback.
