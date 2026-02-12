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

## Per-Commit Logic & CMS Value Evaluation Methodology (Required)

Use this framework for **each upstream commit** before choosing `ported` / `integrated` / `skipped`.

### A. Identify the Logical Nature (What kind of change is this?)

Classify the commit into one primary type:

1. **Behavioral Fix**: bug fix, error handling, defensive checks, correctness.
2. **Feature Addition/Removal**: user-visible functionality changes, including revert commits.
3. **UX/Presentation**: labels, layout, visual interactions, discoverability.
4. **Protocol/Contract**: API shape, provider headers, event schema, auth handshake.
5. **Infra/Tooling**: CI scripts, build, release automation, repo governance.
6. **Docs/Generated Artifacts**: docs, locale content, generated files.

### B. Evaluate CMS Inclusion Value (Should cms absorb this?)

Score each axis as `+1` (positive), `0` (neutral), `-1` (negative):

1. **Architecture Fit**: compatible with cms custom architecture?
   - Check: 3-way provider split, multi-account, Rotation3D, Admin/TUI.
2. **User Value**: improves reliability, efficiency, or clarity for cms users?
3. **Operational Value**: improves observability/debuggability/maintainability?
4. **Regression Risk**: risk to protected paths or known cms custom behavior.
   - For this axis use inverted logic: low risk `+1`, high risk `-1`.

Interpretation:

- **Total >= +2**: generally worth integrating (port/cherry-pick by risk).
- **Total 0~+1**: optional; ask user if ambiguous.
- **Total < 0**: usually skip.

### C. Revert-Commit Rule (Important)

For any upstream `Revert "..."` commit, evaluate both sides:

1. What behavior is being removed?
2. Does cms currently rely on that behavior for product value?
3. Is upstream revert solving an issue that also exists in cms?

Default stance:

- If revert removes cms-useful behavior without fixing a cms-relevant bug → **skip**.
- If revert addresses a real cms regression/risk → **manual port** the intent, not blindly.

### D. Decision Matrix (Action Selection)

- **High risk + high value**: `ported` (manual adaptation only).
- **Low/medium risk + high value + clean patch**: `integrated` (cherry-pick acceptable).
- **Low value or negative fit**: `skipped`.
- **Conflict due to path drift (e.g., moved files)**: port semantic intent into current cms path and mark as `integrated` with note.

### E. Required Plan Output Per Commit

In `refactor_plan_*.md`, each commit entry must include:

- `Logical Type`
- `Value Score` (`fit/user/ops/risk = ...`)
- `Decision` (`ported` / `integrated` / `skipped`)
- `Reason` (1-2 concise sentences)

Example note format:

`Behavioral Fix; fit/user/ops/risk = +1/+1/+1/0 => +3; integrated; clean and valuable for cms runtime reliability.`

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
- `scripts/refactor-pro-mcp.ts`: MCP server (`refactor-pro`) for wizard-guided daily sync and commit triage with interactive execution.
- `references/refactor_pro_mcp.md`: MCP tools usage and daily `origin/dev` catch-up playbook with wizard mode.

## MCP Wizard Mode (refactor-pro)

When available, prefer using MCP tools for consistency and auditability:

1. `refactor_pro_skill_read` → load `refactor-from-src` skill body/references.
2. `refactor_pro_daily_delta` → compute `target..source` commit analyses.
3. `refactor_pro_generate_plan` → generate `docs/events/refactor_plan_*.md` skeleton.
4. Wait for user approval.
5. `refactor_pro_wizard_execute` → interactive execution mode (NEW):
   - For each commit: ask user [Preview / Apply / Skip / Abort]
   - Use `refactor_pro_wizard_question` to guide decisions
   - Execute git operations based on user choices
6. `refactor_pro_update_ledger` → persist final mapping in processed ledger.

For daily sync, default source is `origin/dev`, target is `HEAD` on `cms`.
