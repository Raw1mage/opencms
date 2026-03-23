# Event: Beta Workflow Skill Wiring

**Date**: 2026-03-23
**Status**: In Progress

---

## Requirement

User requested that the beta build workflow stop depending on repeated ad-hoc prompting and instead become a reusable skill named `beta-workflow`, with build-mode explicitly instructing the agent to load that skill during beta-enabled execution.

## Scope

### IN

- Create bundled `beta-workflow` skill content.
- Wire build-mode runner/prompt surfaces so beta-enabled missions explicitly load `beta-workflow`.
- Add focused regression coverage for beta-skill loading behavior.
- Sync enablement registry and framework documentation.

### OUT

- Replacing existing builder beta enforcement logic.
- Removing unrelated workflow-runner behavior changes already present in the worktree.
- Creating commits that would sweep unrelated dirty changes into this task.

## Task List

- Add `templates/skills/beta-workflow/SKILL.md`.
- Update build-mode prompt/runtime surfaces to inject the skill-loading contract.
- Verify focused workflow-runner tests.
- Record documentation + architecture sync status.

## Dialogue Summary

- User said they did not want to keep re-explaining the beta workflow in prompt text.
- The chosen solution was to create a dedicated `beta-workflow` skill and make beta-enabled build runs explicitly load it.
- Existing builder beta enforcement remained useful but was not sufficient alone, because user-observed behavior showed agents could still ignore hardcoded expectations without a clearer execution contract.
- The task therefore became additive: keep enforcement, add an explicit skill-level instruction layer.

## Debug / Implementation Checkpoints

### Baseline

- Builder already had `mission.beta` and runtime enforcement surfaces from the prior beta workflow integration.
- Build-mode prompt/runtime still lacked a dedicated reusable skill contract for beta-enabled execution.

### Instrumentation / Evidence Plan

- Inspect runner prompt/runtime injection points.
- Add a beta-only contract instead of changing non-beta execution.
- Verify with focused workflow-runner tests.
- Check git scope before any commit action because the repo contains unrelated dirty changes.

### Evidence Gathered

- `templates/skills/beta-workflow/SKILL.md` was added as a bundled template skill.
- `packages/opencode/src/session/prompt/runner.txt` now states that beta-enabled build runs must load `beta-workflow` first and keep implementation off the authoritative main repo/worktree.
- `packages/opencode/src/session/workflow-runner.ts` now injects `FIRST: Load skill "beta-workflow"` when mission metadata contains `mission.beta`.
- `packages/opencode/src/session/prompt/enablement.json` and `templates/prompts/enablement.json` now include `beta-workflow` in bundled template skills.
- `packages/opencode/src/session/workflow-runner.test.ts` includes focused assertions for the beta-skill loading contract.
- Git inspection showed the key beta-workflow files are identifiable, but `workflow-runner.ts` and `workflow-runner.test.ts` also contain unrelated behavior changes already present in the worktree.

### Root Decision

- Preserve prior builder beta enforcement.
- Add an explicit reusable skill-loading contract for beta-enabled build execution.
- Do not commit blindly while unrelated dirty changes remain mixed into some of the touched files.

## Key Decisions

1. `beta-workflow` is the reusable instruction surface for beta-enabled execution.
2. Beta-skill loading is injected only when `mission.beta` is present.
3. Non-beta build-mode behavior should remain untouched.
4. Commit safety takes priority over speed because the current worktree contains unrelated modifications.

## Validation

- `bun test packages/opencode/src/session/workflow-runner.test.ts`
  - Result previously observed in this session: `97 pass / 0 fail`.
- Git scope inspection:
  - `packages/opencode/src/session/prompt/enablement.json`, `packages/opencode/src/session/prompt/runner.txt`, and `templates/prompts/enablement.json` show clean task-relevant diffs.
  - `packages/opencode/src/session/workflow-runner.ts` and `packages/opencode/src/session/workflow-runner.test.ts` contain both beta-workflow changes and unrelated worktree edits, so they are not yet safe for blind whole-file commit.
- Architecture Sync: Updated `specs/architecture.md` to record the new beta-skill execution contract in the workflow-runner surface.

## Remaining

- Builder quiz guard implementation remains future build work under the active plan package.
- Immediate blocker discovered during plan handoff: web runtime initially could not access `plan_exit` / `plan_enter` even though the tools existed in code, because tool registration was gated to `app|cli|desktop` while the actual product surface runs as per-user daemon + webapp.
- The blocker has now been fixed directly on the main `cms` branch by registering plan tools for `web` client as well.
- Validation: `bun test packages/opencode/test/tool/registry.test.ts` passed with the new web-client coverage, and `bun test packages/opencode/test/session/bootstrap-policy.test.ts` remained green.
