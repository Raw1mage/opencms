# Handoff

## Execution Contract

- Build/implementation agent must read `implementation-spec.md` first.
- Build/implementation agent must read `proposal.md`, `spec.md`, `design.md`, and the diagram artifacts before coding.
- Build/implementation agent must read `tasks.md` before coding.
- Runtime todo must be materialized from `tasks.md` before execution continues.
- Build/implementation agent must not resume from discussion memory alone when this plan package is available.
- User-visible progress and decision prompts must reuse the same planner-derived todo naming.
- Project context resolution is part of the core contract, not an optional helper.
- When ambiguity or approval is bounded and choice-based, build `beta-tool` to use the `question` tool instead of freeform prose prompts.
- Merge, branch deletion, and beta worktree removal remain approval-gated even after code implementation exists.

## Required Reads

- `proposal.md` (including original requirement wording, revision history, and effective requirement description)
- `spec.md`
- `design.md`
- `implementation-spec.md`
- `tasks.md`
- `idef0.json`
- `grafcet.json`
- `c4.json`
- `sequence.json`

## Stop Gates In Force

- Preserve approval, decision, and blocker gates from `implementation-spec.md`.
- Return to plan mode before coding if a new implementation slice is not represented in planner artifacts.
- Do not create a brand-new sibling plan unless the user explicitly requests it, or explicitly approves an assistant proposal to branch.
- Do not introduce clone-mode fallback, implicit path selection, implicit branch selection, or guessed project policy to rescue failed worktree transitions.
- Do not bypass `question` for bounded ambiguity cases such as merge target, candidate branch naming, beta root choice, or destructive confirmation.

## Execution-Ready Checklist

- [ ] Implementation spec is complete
- [ ] Companion artifacts are aligned
- [ ] Validation plan is explicit
- [ ] Runtime todo seed is present in `tasks.md`
- [ ] Tool schema and fail-fast boundaries are reflected in the diagrams

## Completion / Retrospective Contract

- Review implementation against the proposal's effective requirement description.
- Generate a validation checklist derived from `tasks.md`, runtime todo outcomes, implementation results, and executed validations.
- Report requirement coverage, partial fulfillment, deferred items, and remaining gaps as concise review output.
- Do not expose raw internal chain-of-thought; expose only auditable conclusions and evidence.
