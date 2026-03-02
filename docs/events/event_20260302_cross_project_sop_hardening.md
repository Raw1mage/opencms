# Event: cross-project SOP hardening for docs and debug checkpoints

Date: 2026-03-02
Status: Done

## Goal

- Make documentation + debug checkpoints a consistent, cross-project mandatory workflow.
- Strengthen AGENTS/skill baselines so future projects follow the same development discipline.

## Scope

- IN:
  - `.opencode/AGENTS.md`
  - `templates/AGENTS.md`
  - `templates/skills/agent-workflow/SKILL.md`
  - `packages/opencode/src/command/template/AGENTS.md`
- OUT:
  - runtime behavior changes
  - API/server logic changes

## Changes

1. Added mandatory cross-project SOP gate in project AGENTS:
   - Event-first requirement
   - Baseline/Execution/Validation checkpoints
   - Completion gate with validation evidence

2. Added same hard requirements in `templates/AGENTS.md`:
   - Ensures newly initialized projects inherit identical SOP baseline.

3. Enhanced `agent-workflow` template skill:
   - Added required Documentation & Debug Checkpoints phase.
   - Added completion gate language and event-path requirement for major debug/refactor tasks.

4. Synced command template AGENTS:
   - Added mandatory checkpoint section to generated command template governance.

## Expected Outcome

- Future projects using template AGENTS + workflow skill will consistently enforce:
  - event-led planning,
  - traceable debug checkpoints,
  - explicit validation before completion.
