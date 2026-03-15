# Tasks

## 1. Planner Contract Rewrite

- [ ] 1.1 Rewrite `packages/opencode/src/tool/plan.ts` fallback templates so planner artifacts encode architecture fields, delegation-first execution slices, and explicit bootstrap policy
- [ ] 1.2 Update `implementation-spec.md`, `proposal.md`, `spec.md`, `design.md`, and `handoff.md` template expectations in `plan.ts` to match the new autorunner contract

## 2. Runner And Prompt Contract Rewrite

- [ ] 2.1 Rewrite `packages/opencode/src/session/prompt/runner.txt` so narration is non-blocking and delegation-first continuation is explicit
- [ ] 2.2 Rewrite `packages/opencode/src/session/prompt/plan.txt`, `packages/opencode/src/session/prompt/claude.txt`, `packages/opencode/src/session/prompt/anthropic-20250930.txt`, `packages/opencode/src/session/system.ts`, and `agent-workflow` skill mirrors to align planning-first and execution-first language with the new autorunner contract

## 3. Bootstrap And Capability Policy Rewrite

- [ ] 3.1 Update `AGENTS.md` and `templates/AGENTS.md` to remove default loading of `model-selector`, `software-architect`, `mcp-finder`, and `skill-finder`
- [ ] 3.2 Update `packages/opencode/src/session/prompt/enablement.json`, `templates/prompts/enablement.json`, `templates/system_prompt.md`, and `templates/global_constitution.md` so removed skills are on-demand only and no longer implied bootstrap dependencies

## 4. Validation And Documentation Sync

- [ ] 4.1 Add or update targeted tests for planner template generation, runner wording, and bootstrap policy regressions
- [ ] 4.2 Run targeted validation and record evidence
- [ ] 4.3 Sync `docs/events/event_20260315_autorunner_planner_retarget.md` and verify whether `docs/ARCHITECTURE.md` needs changes
