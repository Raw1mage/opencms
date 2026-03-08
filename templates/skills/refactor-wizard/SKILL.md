---
name: refactor-wizard
description: Interactive Merge Wizard to safely merge origin/dev into cms, handling architectural divergence (3-way split, multi-account, admin panel).
---

# Interactive Merge Wizard (refactor-wizard)

## Description

This skill transforms the agent into an interactive wizard to manage the complex merge process from `origin/dev` into the custom `cms` branch.

It guides you through analyzing divergence, planning the merge strategy for each commit, and safely executing changes while preserving critical `cms` features:

1.  **Canonical Google Provider Split** (`google-api`, `gemini-cli`).
2.  **Multi-account Support**.
3.  **Rotation3D**.
4.  **Admin Panel & TUI** (`src/cli/cmd/admin.ts`, `src/cli/cmd/tui/`).

**Key Principle**: The `gemini-cli` plugin is strictly for **OAuth Client Simulation**. Internal account switching or rate limiting features within plugins should be discarded in favor of CMS's global `Account` and `Rotation3D` modules.

**Language Requirement**: All interactions with the user must be in **Traditional Chinese (繁體中文)**.

## Workflow (Strict Agent Workflow)

Follow the `agent-workflow` state machine:

### 1. ANALYSIS

- **Goal**: Understand the scope of divergence.
- **Action**:
  - Run `python3 scripts/analyze_divergence.py`.
  - Read the generated `divergence.json`.
  - Review the `references/merge_wizard.md` for guidance.
- **Output**: A summary of High/Medium/Low risk commits.

### 2. PLANNING (Interactive Analysis)

- **Goal**: Determine the strategy for each divergent commit.
- **Action**:
  - **Deep Analysis**: For High Risk items, perform a deep code analysis explaining _why_ the change matters to CMS.
  - **Risk Assessment**: **NEW**: Include a risk assessment for proposed actions (potential side effects, API breaks, etc.).
  - **Interactive Analysis**: Engage the user in a dialogue using `mcp_question` (in Traditional Chinese).
  - Prioritize HIGH risk items (critical paths).
  - Discuss MEDIUM risk items (source code).
  - Batch LOW risk items.
  - **Decision Logic**: For Plugin updates, keep OAuth/Token logic, discard Account Manager logic.
- **Output**: Create a `docs/events/refactor_plan_YYYYMMDD.md` file detailing the agreed-upon actions.

### 3. WAITING_APPROVAL

- **Goal**: User confirmation of the plan.
- **Action**: Present the plan file to the user. Ask for explicit approval to proceed.
- **Constraint**: Do not execute any code changes until approved.

### 4. EXECUTION (STRICT ONE-BY-ONE MODE)

**CRITICAL INSTRUCTION**:

- **NEVER DIRECTLY MERGE** without analysis.
- **MANDATORY LOGIC ANALYSIS**: You must understand _what_ the code does, not just _that_ it changed.
- **EXPLAIN TO USER**: You must explain the change, impact, and risk to the user in Traditional Chinese.
- **EVALUATE FEASIBILITY & RISK**: assess if the change fits CMS architecture.
- **GET USER AUTHORIZATION**: You must get explicit approval for EACH commit or small batch.
- **REWRITE/REFACTOR APPROACH**: Instead of blind cherry-pick, prefer reading the source diff and _rewriting_ the logic into CMS to ensure architecture integrity.

**Step-by-Step Loop for EACH Commit:**

1.  **Identify**: Pick the next commit from the plan.
2.  **Analyze**: Read the diff. Understand the logic.
3.  **Question**: Use `mcp_question` to present:
    - Commit Subject
    - Logical Change Analysis
    - Risk Assessment (CMS Compatibility)
    - Proposed Action (Port / Integrate / Skip)
4.  **Wait**: Wait for user selection/instruction.
5.  **Execute**:
    - If `Port/Integrate`: Apply changes (prefer `git cherry-pick -n` then inspect, or manual code edit).
    - If `Skip`: Record in ledger as skipped.
6.  **Verify**: Run relevant tests.
7.  **Loop**: Proceed to next commit.

## Critical Paths & Protected Areas

Modifications to these areas require **manual porting** and **high scrutiny**:

- `src/provider/` (The canonical Google provider split logic)
- `src/account/` (Multi-account logic)
- `src/session/llm.ts` (Rotation3D)
- `src/cli/cmd/admin.ts` (Admin Panel entry point)
- `src/cli/cmd/tui/` (Text User Interface components)
- `src/plugin/gemini-cli/` (Internal plugin helpers should NOT override global Accounts)

## Tools & References

- `scripts/analyze_divergence.py`: Generates the divergence report and JSON data.
- `references/merge_wizard.md`: Contains the interactive script (in Traditional Chinese), question templates, and plan format.
