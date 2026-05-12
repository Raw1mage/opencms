# Interactive Merge Wizard Script

This reference guides the agent through the interactive merge process.

## Phase 1: Analysis & Discovery

1.  **Execute Analysis**: Run `python3 scripts/analyze_divergence.py`.
2.  **Load Data**: Read the generated `divergence.json`.
3.  **Present Summary**: Show the user a high-level summary of the divergence (e.g., "Found 5 commits. 2 High Risk, 1 Medium Risk, 2 Low Risk.").

## Phase 2: Interactive Strategy (Planning)

Iterate through the commits in `divergence.json`. For each commit (prioritizing High/Medium risk), ask the user for guidance.

Before asking, do a short per-commit analysis and summarize in one line:

- `Logical Type` (Behavioral Fix / Feature / UX / Protocol / Infra / Docs)
- `Value Score` (`fit/user/ops/risk = ...`, each axis -1/0/+1)
- `Default Recommendation` (`ported` / `integrated` / `skipped`)

### Question Templates

**For High Risk Commits (Critical Path):**

> "Commit `{hash}` (`{subject}`) touches critical paths: `{reasons}`.
> Logical Type: `{logical_type}`
> Value Score: `fit/user/ops/risk = {f}/{u}/{o}/{r} => {total}`
> This involves core architecture (Providers/Accounts/Rotation3D) or the Admin Panel.
> **Options:**
>
> 1. Skip this commit (irrelevant to CMS).
> 2. Manual Port: I will read the code and attempt to adapt the logic to our architecture.
> 3. Cherry-pick & Conflict Resolution: Try to apply it and fix conflicts (riskier).
>
> What is your preference?"

**For Medium Risk Commits (Source Code):**

> "Commit `{hash}` (`{subject}`) modifies source code.
> Logical Type: `{logical_type}`
> Value Score: `fit/user/ops/risk = {f}/{u}/{o}/{r} => {total}`
> **Options:**
>
> 1. Cherry-pick directly.
> 2. Review diff first.
>
> Shall I proceed with cherry-picking?"

**For Low Risk Commits (Docs/Tests):**

> "I have {count} low-risk commits. Shall I batch cherry-pick them all?"

## Phase 3: Plan Generation

Based on user responses, generate a `docs/events/refactor_plan_YYYYMMDD.md` file.

### Refactoring Plan Format

```markdown
# Refactoring Plan: {Date}

## Summary

- Total Commits: {count}
- Strategy: {Mixed/Cherry-pick/Manual}

## Actions

| Commit | Logical Type | Value Score | Decision              | Notes                        |
| :----- | :----------- | :---------- | :-------------------- | :--------------------------- |
| {hash} | {Type}       | {f/u/o/r=t} | {Skip/Port/Integrate} | {User notes or risk details} |

## Execution Queue

1. [ ] Cherry-pick Low risk items.
2. [ ] Manual port of {hash} (High Risk).
3. [ ] ...

## Mapping to Ledger

| Upstream Commit | Status                      | Local Commit      | Note              |
| :-------------- | :-------------------------- | :---------------- | :---------------- |
| {hash}          | {ported/integrated/skipped} | {local-hash or -} | {final rationale} |
```

## Phase 4: Execution

1.  **Wait for Approval**: Ask the user to confirm the generated plan.
2.  **Execute**: Follow the "Execution Queue" in the plan.
    - For "Manual Port":
      - Read the file content from the commit (`git show {hash}:{file}`).
      - Read the local file.
      - Apply changes while respecting `CRITICAL_PATHS` constraints (e.g., preserving `src/provider/` split or `src/cli/cmd/admin.ts` integrity).
