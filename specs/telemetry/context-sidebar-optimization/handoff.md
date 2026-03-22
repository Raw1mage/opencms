# Handoff

## Execution Contract

- Build/implementation agent must read `implementation-spec.md` first.
- Build/implementation agent must read `proposal.md`, `spec.md`, `design.md`, and `tasks.md` before coding.
- Runtime todo must be materialized from `tasks.md` before execution continues.
- Build/implementation agent must not resume from discussion memory alone when this plan package is available.
- User-visible progress and decision prompts must reuse the same planner-derived todo naming.
- Build/implementation agent must preserve the chosen optimization posture: regroup legacy context info into `Summary / Breakdown / Prompt` cards and add drag ordering.
- If the code suggests a broader authority rewrite is required, stop and return to `specs/telemetry/` before coding.

## Required Reads

- `proposal.md` (including original requirement wording, revision history, and effective requirement description)
- `spec.md`
- `design.md`
- `implementation-spec.md`
- `tasks.md`

## Current State

- Planning artifacts now reflect the user-approved three-card MVP: `Summary / Breakdown / Prompt`.
- Diagram artifacts (`idef0.json`, `grafcet.json`, `c4.json`, `sequence.json`) are now tied to the actual context sidebar optimization slice instead of template placeholders.
- No code implementation has started yet; build mode still requires explicit user approval.

## Stop Gates In Force

- Preserve approval, decision, and blocker gates from `implementation-spec.md`.
- Return to the parent telemetry root before coding if a new implementation slice is not represented in planner artifacts.
- Do not create a brand-new sibling plan unless the user explicitly requests it, or explicitly approves an assistant proposal to branch.
- Stop if implementation would require backend telemetry contract changes or new fallback behavior not represented in this plan.

## Build Entry Recommendation

- Start from `packages/app/src/components/session/session-context-tab.tsx` to split the legacy loose-text section into stable card sections.
- Then inspect `packages/app/src/context/layout.tsx` and `packages/app/src/pages/session/session-status-sections.tsx` to reuse or extend the existing status-sidebar drag/persistence pattern for context cards.
- Touch `session-side-panel.tsx` / `tool-page.tsx` only as needed to preserve context surface wiring and route-level behavior.

## Execution-Ready Checklist

- [x] Card grouping target is explicitly chosen (`Summary / Breakdown / Prompt`)
- [x] Implementation spec is complete
- [x] Companion artifacts are aligned
- [x] Validation plan is explicit
- [x] Runtime todo seed is present in `tasks.md`

## Completion / Retrospective Contract

- Review implementation against the proposal's effective requirement description.
- Generate a validation checklist derived from `tasks.md`, runtime todo outcomes, implementation results, and executed validations.
- Report requirement coverage, partial fulfillment, deferred items, and remaining gaps as concise review output.
- Do not expose raw internal chain-of-thought; expose only auditable conclusions and evidence.
