# Handoff

## Execution Contract

- This planner package is the canonical plan root for the current workstream.
- Build agent must read `implementation-spec.md` first.
- Build agent must read `tasks.md` before coding.
- Build agent must materialize runtime todo from this package's `tasks.md` before continuing implementation.
- Build agent must not resume from discussion memory alone when this planner package is available.
- Build agent must ask for user decisions against the same planner-derived runtime todo names shown in sidebar/status, not a private alternate checklist.

## Required Reads

- `proposal.md` (including original user wording + revision history)
- `spec.md`
- `design.md`
- `implementation-spec.md`
- `tasks.md`
- `plan-build-target-model.md`
- `autorunner-compat-analysis.md`
- `runner-contract.md`
- `planner-hardening-roadmap.md`

## Stop Gates In Force

- Preserve approval, decision, and blocker gates from `implementation-spec.md`.
- Return to plan mode before coding if a new implementation slice is not yet represented in this planner package.
- Stop for privileged environment changes such as `/etc/opencode` host install unless the required permissions are available.
- Stop and replan if planner/build/runner ownership boundaries materially change during deeper runtime convergence.
- Do not reopen sibling top-level plan roots for this same workstream; extend this canonical package instead.
- Do not create a brand-new sibling plan unless the user explicitly requests it, or explicitly approves an assistant proposal to branch.

## Current Execution Ordering

1. Continue any remaining legacy `plan/build` convergence work
2. Continue any remaining controlled restart operational closure
3. Extend future related slices under this same root when they belong to this workstream

## Execution-Ready Checklist

- [x] Canonical planner root for this workstream exists
- [x] Main six planner files are present
- [x] Supporting docs for runner/target-model/restart work are collocated in the same root
- [x] Runtime todo is materialized from `tasks.md`
- [x] Build-mode continuation resumes from documented plan artifacts rather than conversation memory alone

## Completion / Retrospective Contract

- At completion time, review against the original user requirement wording and its tracked revisions.
- Produce a validation checklist derived from `tasks.md`, runtime todo outcomes, implementation results, and executed validations.
- Report requirement coverage, partial fulfillment, deferred items, and remaining gaps as concise review output.
- Do not expose raw internal chain-of-thought; expose only auditable conclusions and evidence.

## Naming and expansion rule

- This package is intentionally extensible.
- New implementation/design slices for the same workstream should extend this root instead of creating a new sibling plan folder for every discussion branch.
- Other distinct workstreams may still have their own separate plan roots under `/specs/`, but only after explicit user request or explicit approval.
