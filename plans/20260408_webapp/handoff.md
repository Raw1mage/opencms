# Handoff

## Execution Contract

- Build agent must read `implementation-spec.md` first.
- Build agent must read `proposal.md`, `spec.md`, `design.md`, and `tasks.md` before coding.
- Runtime todo must be materialized from `tasks.md` before execution continues.
- Build agent must not rely on discussion memory when this plan package is available.
- Same-workstream changes stay inside `plans/20260408_webapp/` unless the user explicitly approves a new plan root.

## Required Reads

- `plans/20260408_webapp/implementation-spec.md`
- `plans/20260408_webapp/proposal.md`
- `plans/20260408_webapp/spec.md`
- `plans/20260408_webapp/design.md`
- `plans/20260408_webapp/tasks.md`
- `specs/architecture.md`
- `docs/events/event_20260408_webapp_voice_input_mvp.md`

## Current State

- Planning mode is active; speech input MVP scope has been narrowed to browser-only webapp integration.
- Repo exploration confirmed `packages/app/src/utils/speech.ts` and `packages/app/src/utils/runtime-adapters.ts` already exist.
- No implementation has started yet; planner artifacts are aligned as the execution contract.
- Event log has been created at `docs/events/event_20260408_webapp_voice_input_mvp.md`.

## Stop Gates In Force

- Stop if prompt editor integration would require broad `contenteditable` architecture changes.
- Stop if browser-only speech helper proves insufficient and the work expands into backend STT.
- Stop if a fallback mechanism is needed to hide unsupported/error states.
- Stop and re-plan if requested scope expands beyond webapp prompt input MVP.

## Build Entry Recommendation

- Enter build through the beta workflow, not the authoritative main worktree.
- Before any implementation, restate beta authority fields from mission metadata: `mainRepo`, `mainWorktree`, `baseBranch`, `implementationRepo`, `implementationWorktree`, `implementationBranch`, `docsWriteRepo`.
- Confirm the admitted implementation surface is separate from the authoritative mainline surface.
- Start from `tasks.md` section 1 to confirm the approved scope, then implement section 2 inside `packages/app/src/components/prompt-input.tsx` with `speech.ts` as the only speech state surface.

## Execution-Ready Checklist

- [x] Implementation spec is complete
- [x] Companion artifacts are aligned
- [x] Validation plan is explicit
- [x] Runtime todo seed is present in `tasks.md`
- [x] Event log is present for this planning session

## Completion / Retrospective Contract

- Review implementation against the proposal's effective requirement description.
- Generate a validation checklist derived from `tasks.md`, runtime todo outcomes, implementation results, and executed validations.
- Report requirement coverage, partial fulfillment, deferred items, and remaining gaps as concise review output.
- Do not expose raw internal chain-of-thought; expose only auditable conclusions and evidence.
- If build runs on beta workflow, completion additionally requires beta/test disposable surface cleanup and authoritative-mainline verification per the beta workflow contract.