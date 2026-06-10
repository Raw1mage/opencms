---
name: bug-report
description: Create handoff-quality bug reports and issue files for reproducible debugging. Use whenever the user asks to write a bug report, file an issue, document a bug, make a problem reproducible, prepare a next-session handoff, or says phrases like "bug report", "BR", "寫個 BR", "看一下這個 BR", "更新 BR", "把這個 bug 寫成 BR", "issue", "讓新 session 接手", "這個 bug 幫我寫 report". "BR" is the standard shorthand for "bug report" and MUST trigger this skill. Produces a complete, standardized issue document with evidence, reproduction steps, hypotheses, acceptance criteria, and next-session checklist.
---

# Bug Report Skill

Use this skill to create a self-contained bug report that a fresh session can use to reproduce, diagnose, prioritize, and fix a bug without relying on prior chat history.

## Shorthand: "BR"

**BR** is the standard shorthand for **bug report**. Whenever the user says "BR" — e.g. "寫個 BR", "看一下這個 BR", "更新 BR", "把這個 bug 寫成 BR", "幫我開一個 BR" — treat it as a direct invocation of this skill.

- A BR is a bug feedback document living at `<repo>/issues/<name>.md` (the repo's local `issues/` directory).
- "寫 / 開 / 建 BR" → create a new issue file using this skill's template at the Default Output Location below.
- "看 / 讀 BR" → read the relevant `issues/<name>.md`.
- "更新 / 補 BR" → append findings/evidence to the existing issue file.
- "關 / close BR" → follow the Closing / Resolved Issue Rule (append resolution, then move to `issues/closed/`).

## Core Rule

A bug report is not just a narrative. It is a handoff artifact. It must separate facts from hypotheses, preserve evidence, define reproduction steps, and end with concrete next actions.

## Default Output Location

When the user asks to create an issue file and does not specify a path, use:

```text
issues/<date><title>_issue.md
```

Filename rule:

- `<date>`: `YYYYMMDD`
- `<title>`: concise `snake_case`
- suffix: `_issue.md`

Example:

```text
issues/20260513_apply_patch_false_success_path_resolution_issue.md
```

If `issues/` does not exist, create it.

## Required Bug Report Template

Every report MUST include these sections.

### 0. Handoff Summary

Write 3-8 sentences covering:

- what failed
- why it matters
- current status
- whether the bug is confirmed or only suspected
- what the next session should do first

### 1. Bug Identity

Use a table:

```markdown
| Field                         | Value                                                |
| ----------------------------- | ---------------------------------------------------- |
| Title                         | <short bug title>                                    |
| Component                     | <system/module/tool>                                 |
| Reporter                      | <person/session/context>                             |
| Date                          | <YYYY-MM-DD>                                         |
| Severity                      | <critical/high/medium/low + reason>                  |
| Priority                      | <P0/P1/P2/P3 + reason>                               |
| Status                        | <new/needs reproduction/confirmed/in progress/fixed> |
| Affected versions/tools/paths | <versions or paths>                                  |
```

### 2. Environment

Include everything needed to reproduce:

- repo path
- cwd
- OS/runtime if known
- relevant mounts/symlinks/services
- tool versions if known
- branch/worktree if relevant
- config files or env vars if relevant, but never expose secrets

### 3. Expected Behavior

State the contract clearly:

- what should happen
- success criteria
- invariants that must hold
- what must never happen

### 4. Actual Behavior

State observed facts:

- exact symptoms
- error messages
- stale output or unexpected output
- screenshots/log references if available
- when it happened

Do not mix root-cause guesses into this section.

### 5. Steps To Reproduce

Use numbered steps. Prefer minimal reproduction.

Each step should include:

- action or command/tool call
- required fixture/file
- expected observation at that step
- actual observation if known

If reproduction is not yet exact, label it as `Suggested reproduction`.

### 6. Evidence

List evidence in a table:

```markdown
| Evidence | Type      | Reference           | What it shows |
| -------- | --------- | ------------------- | ------------- |
| E1       | tool call | `call_xxx`          | <summary>     |
| E2       | file      | `path/to/file:line` | <summary>     |
| E3       | log       | `path/to/log`       | <summary>     |
```

Rules:

- Include recallable tool call ids when prior outputs were compacted.
- Include absolute paths when handoff-critical.
- Use `file_path:line_number` when citing code.
- Mark uncertain evidence as uncertain.

### 7. Impact / Risk

Cover:

- user-visible impact
- data-loss or data-corruption risk
- reliability risk
- security risk if any
- workflow impact
- blast radius

### 8. Root-Cause Hypotheses

Hypotheses must be labeled as hypotheses, not facts.

For each hypothesis include:

```markdown
### H1: <hypothesis>

Confidence: <low/medium/high>

Why plausible:

- <evidence or reasoning>

How to confirm:

- <test/check>

How to refute:

- <test/check>
```

### 9. Workarounds

List temporary mitigations:

- workaround
- when to use it
- risk or downside
- when not to use it

### 10. Proposed Fix Direction

Describe the likely fix path:

- code-level or design-level change
- compatibility constraints
- migration or behavior-change concerns
- tests that should accompany the fix

Do not over-prescribe if the root cause is not confirmed.

### 11. Acceptance Criteria

Define done with objective checks:

- positive tests
- negative tests
- regression tests
- user-visible behavior
- logging/diagnostics if relevant

### 12. Open Questions

List unresolved items:

- missing information
- required decisions
- ownership questions
- ambiguous behavior contracts

### 13. Next Session Checklist

End with exact next actions:

1. first file to open
2. first command/test to run
3. evidence to recall
4. code area to inspect
5. reproduction to attempt
6. expected stopping point

## Optional Sections

Add only when relevant:

- Timeline
- Attachments
- Related issues / PRs
- Bisect notes
- Security considerations
- Data integrity notes
- Rollback plan
- Release note wording
- Customer/user communication draft

## Style Rules

- Be concise but complete.
- Separate facts from hypotheses.
- Never invent evidence.
- Do not assume the next session can read prior chat.
- Prefer absolute paths for handoff-critical files.
- Include at least one reproduction path, even if approximate.
- If evidence is compacted, include recallable tool call ids.
- Do not claim root cause without verification.
- Use Traditional Chinese for user-facing prose unless the project/report is in English.

## Closing / Resolved Issue Rule

When a bug report or issue is fixed, do not leave the original report stale. Before moving it to `issues/closed/`, append a resolution section to the original report with all of the following:

1. **Resolution Status**
   - Mark as fixed/resolved.
   - Include date and repo/worktree where fixed.

2. **Final RCA**
   - State the confirmed root cause.
   - Explain which initial hypotheses were confirmed, rejected, or left unproven.
   - Do not overclaim evidence that was not verified.

3. **Fix Implemented**
   - List changed files.
   - Summarize the behavior change.
   - Mention compatibility or migration implications.

4. **Verification Results**
   - Include exact commands/tests run.
   - Include pass/fail counts or meaningful output summary.
   - Include any verification gaps or deferred checks.

5. **Follow-ups / Residual Risk**
   - List remaining open questions or non-blocking follow-ups.
   - If none, state that no follow-up is currently required.

After that append is complete, move the report from `issues/` to `issues/closed/` using the same filename. Do not delete the report. Do not move unresolved reports.

If a bug was fixed in the same session that filed it, still append the closing RCA before moving it to `issues/closed/`.

## Minimal Skeleton

```markdown
# Bug Report: <title>

## 0. Handoff Summary

## 1. Bug Identity

## 2. Environment

## 3. Expected Behavior

## 4. Actual Behavior

## 5. Steps To Reproduce

## 6. Evidence

## 7. Impact / Risk

## 8. Root-Cause Hypotheses

## 9. Workarounds

## 10. Proposed Fix Direction

## 11. Acceptance Criteria

## 12. Open Questions

## 13. Next Session Checklist
```
