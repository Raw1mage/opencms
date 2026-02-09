---
name: refactor-from-src
description: Daily refactor workflow to continuously sync origin/dev into cms with protected-area rules, commit ledger, and verification gates.
---

# Daily Refactor Workflow (refactor-from-src)

## Description

Use this skill as the **default daily SOP** for syncing `origin/dev` changes into `cms`.

Core goals:

1. Keep `cms` close to upstream with controlled risk.
2. Protect `cms` custom architecture and behavior.
3. Maintain a durable processed-commit ledger for future ignore lists.

Always preserve these `cms` features:

- **3-way Google Provider Split** (`google-api`, `gemini-cli`, `antigravity`)
- **Multi-account Support**
- **Rotation3D**
- **Admin Panel & TUI** (`src/cli/cmd/admin.ts`, `src/cli/cmd/tui/`)

## Daily Cadence

Run this flow at least once per day (or per release cut):

1. **Fetch & Diff**: identify `HEAD..origin/dev` commit list.
2. **Classify**: `core/src`, `app/web/console`, `infra/docs`.
3. **Decide Strategy**: port / cherry-pick / skip.
4. **Execute in batches** with tests after each batch.
5. **Record ledger** and push.

---

## Workflow (Strict State Machine)

Follow the `agent-workflow` state machine:

### 1. ANALYSIS

- **Goal**: Build daily upstream delta and risk map.
- **Action**:
  - Fetch remotes and inspect `HEAD..origin/dev`.
  - Identify touched areas per commit.
  - Check existing ledger: `docs/events/refactor_processed_commits_YYYYMMDD.md`.
- **Output**:
  - New commit set (excluding processed/skipped)
  - Risk tiers: High / Medium / Low

### 2. PLANNING (Interactive Analysis)

- **Goal**: Decide per-commit handling strategy.
- **Action**:
  - For each commit choose one: `ported` / `integrated` / `skipped`.
  - Batch by scope:
    - Batch A: `src/` core
    - Batch B: `packages/app|web|console|desktop`
    - Batch C: docs/infra (`nix`, generated artifacts)
  - Confirm high-risk decisions with user.
- **Output**:
  - `docs/events/refactor_plan_YYYYMMDD_<topic>.md`
  - Explicit test matrix per batch

### 3. WAITING_APPROVAL

- **Goal**: User confirmation of the plan.
- **Action**: Present batch plan + expected risks + rollback path.
- **Constraint**: Do not modify code before approval.

### 4. EXECUTION

- **Goal**: Apply daily delta safely and leave auditable traces.
- **Action**:
  - Prefer **manual port** for protected areas.
  - Use cherry-pick / targeted merge only for low-risk compatible commits.
  - Resolve conflicts with `cms` behavior as source-of-truth.
- **Verification gates**:
  - Batch-level tests must pass before next batch.
  - Final `typecheck` and regression tests before push.

## Critical Paths & Protected Areas

Modifications to these areas require **manual porting** and **high scrutiny**:

- `src/provider/` (The 3-way split logic)
- `src/account/` (Multi-account logic)
- `src/session/llm.ts` (Rotation3D)
- `src/cli/cmd/admin.ts` (Admin Panel entry point)
- `src/cli/cmd/tui/` (Text User Interface components)

## Commit Ledger Rule (Required)

After every daily run, update ledger in `docs/events/`:

- file pattern: `refactor_processed_commits_YYYYMMDD.md`
- include columns:
  - upstream hash
  - status (`ported` / `integrated` / `skipped`)
  - local commit hash (or merge commit)
  - note

Next run must load ledger first and exclude already processed hashes.

## Verification Matrix (Minimum)

- Core touched (`src/**`): run core/session/provider/acp tests.
- App/Web/Console touched: run relevant package typecheck/tests.
- Before push: run monorepo typecheck gate (`bun turbo typecheck`).

## Stop Conditions

Stop and report immediately if:

1. Protected-area behavior uncertain.
2. Repeated flaky test without clear root cause.
3. Conflict needs product decision.

Include: what failed, what was tried, and exact decision needed.

## Tools & References

- `scripts/analyze_divergence.py`: Generates the divergence report and JSON data.
- `references/merge_wizard.md`: Contains the interactive script, question templates, and plan format.
