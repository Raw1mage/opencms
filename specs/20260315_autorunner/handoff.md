# Handoff

## Execution Contract

- Build agent must read `implementation-spec.md` first and treat it as the authority for this autorunner optimization slice.
- Build agent must read `proposal.md`, `spec.md`, `design.md`, and `tasks.md` before coding.
- Runtime todo must be materialized from `tasks.md` before execution continues.
- Build agent must preserve the fail-fast / no-silent-fallback posture while rewriting planner and runner prompts.
- Build agent must keep `templates/skills/agent-workflow/SKILL.md` and the runtime skill mirror aligned if workflow semantics change.
- User-visible progress and decision prompts must reuse the same planner-derived task names.

## Required Reads

- `specs/20260315_autorunner/implementation-spec.md`
- `specs/20260315_autorunner/proposal.md`
- `specs/20260315_autorunner/spec.md`
- `specs/20260315_autorunner/design.md`
- `specs/20260315_autorunner/tasks.md`
- `docs/events/event_20260315_autorunner_planner_retarget.md`

## Stop Gates In Force

- Preserve approval, decision, blocker, and no-fallback gates from `implementation-spec.md`.
- Return to plan mode before coding if new bootstrap removals, new skill distribution policy, or daemon-substrate work appears outside this plan.
- Do not silently reintroduce removed default skills through prompt text, enablement hints, or template wording.

## Execution-Ready Checklist

- [ ] Implementation spec is complete
- [ ] Companion artifacts are aligned
- [ ] Validation plan is explicit
- [ ] Runtime todo seed is present in `tasks.md`

## Completion / Retrospective Contract

- Review implementation against the proposal's effective requirement description.
- Report whether autorunner bootstrap is now minimal, whether planner absorbed architecture-thinking, and whether delegation-first continuation is reflected in runtime prompt surfaces.
- Include targeted validation evidence for planner templates, prompt routing, and bootstrap policy.
- Do not expose raw internal chain-of-thought; expose only conclusions, changed files, and evidence.
