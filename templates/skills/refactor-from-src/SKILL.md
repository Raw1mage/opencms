---
name: refactor-from-src
description: Workflow for analyzing upstream behavior changes and planning manual replication in cms. STRICTLY NO MERGING.
---

# Behavior Replication Workflow (refactor-from-src)

## 🚨 CRITICAL RULE: NO MERGING 🚨

**ABSOLUTELY NO `git merge`, `git cherry-pick`, or direct code integration from `origin/dev` is allowed.**

The `cms` branch architecture has diverged significantly from `origin/dev`. Any attempt to merge or cherry-pick will result in catastrophic architectural conflicts.

**The ONLY allowed operation is:**
1. **Analyze** upstream commits for *behavioral* value.
2. **Document** the behavioral gap.
3. **Plan** a manual re-implementation (port) of the behavior using `cms` architecture.

## Core Philosophy

We are **archaeologists**, not mergers. We dig through `origin/dev` commits to find "lost knowledge" (bug fixes, edge case handling, protocol tweaks) and determine if `cms` needs to learn that behavior.

## Workflow

### 1. ANALYSIS (Archaeology)
- **Goal**: Identify *what* happened in `origin/dev` that `cms` might be missing.
- **Tools**: `git log`, `git show`, `refacting-merger-mcp`.
- **Action**:
  - Fetch `origin/dev`.
  - list commits using `refacting-merger-mcp` (or similar analysis script).
  - **Ignore** architecture/refactor commits.
  - **Focus** on `fix:`, `feat:`, `perf:` that touch logic/behavior.

### 2. BEHAVIORAL EVALUATION
For each candidate commit, ask:

1.  **Architecture Check**: Does `cms` even *have* this problem?
    *   *Example*: Upstream fixed a JSON-lock race condition. `cms` uses SQLite. -> **Irrelevant**.
2.  **Behavioral Gap**: Is this a logic bug that affects both?
    *   *Example*: Upstream fixed a regex for parsing model output. `cms` likely uses similar regex. -> **Relevant**.
3.  **Protocol Alignment**: Is this a change in how we talk to LLMs/APIs?
    *   *Example*: Anthropic added a new header requirement. -> **Critical**.

### 3. PLANNING (Replication Plan)
- **Goal**: Create a "Spec" for manual implementation.
- **Output**: A new `event_log` or update to `TECH_DEBT.md` / `TODO.md`.
- **Format**:
    ```markdown
    ## Behavior Candidate: [Commit Hash] - [Subject]
    - **Upstream Logic**: [Explanation of what they fixed/changed]
    - **CMS Status**: [Explanation of current CMS behavior]
    - **Gap Analysis**: [Does CMS need this? Why?]
    - **Implementation Plan**: [How to implement this in CMS architecture]
    ```

### 4. EXECUTION (Manual Replication)
- **Action**: Write *new code* in `cms` to match the desired behavior.
- **Verification**: Add tests to prove the behavior matches the intent.

## Decision Categories

When analyzing commits, categorize them as:

*   **`IRRELEVANT`**: Architecture specific to `origin/dev` (e.g., locking, old file, removed module).
*   **`ALREADY_IMPLEMENTED`**: `cms` naturally handles this or already has the fix.
*   **`CANDIDATE`**: A logical/behavioral fix that `cms` needs but lacks. -> **Needs Plan**.

## Tools & References

- `scripts/refacting-merger-mcp.ts`: Analysis tool (use `--cli` mode).
- `docs/events/`: Store analysis logs here.
