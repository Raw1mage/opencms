# handoff.md — grafcet-renderer-overhaul

## Execution Contract

The implementer (main agent in autonomous loop) executes phases 1 through 8 from `tasks.md` in order. Each phase loads its `- [ ]` items into TodoWrite at the boundary; mid-phase, only status updates are allowed.

After each task: mark `- [x]` in tasks.md, run `plan-sync.ts`, update TodoWrite. After each phase: write a phase summary into the working session log and roll TodoWrite to the next phase.

Stop only at legitimate gates (§16.5 of plan-builder skill).

## Required Reads

Before any implementation step:

1. `proposal.md` — full defect inventory (D-01..D-23) and original user wording (33 quotes).
2. `spec.md` — Requirements R-1..R-13 with GIVEN/WHEN/THEN scenarios.
3. `design.md` — Decisions DD-1..DD-18; Risks; Critical Files.
4. `data-schema.json` — port / gate / branch_anchor / violation / trace_event types.
5. `tasks.md` — phase-organized checklist (canonical task source).
6. `/home/pkcs12/projects/drawmiat/webapp/grafcet_renderer.py` — current implementation; ~4200 lines.

Reference (read as needed during a phase):

7. `/home/pkcs12/projects/opencode/specs/*/grafcet.json` — input fixtures.
8. `/home/pkcs12/projects/opencode/specs/*/grafcet.svg` — current outputs.
9. `/home/pkcs12/projects/skills/miatdiagram/` — IDEF0/Grafcet schema rules.

## Stop Gates In Force

The agent MUST pause and request user input if:

- A phase reveals an architectural decision not covered by DD-1..DD-18 (escalates to `revise` or `extend` mode).
- A figure's re-render in Phase 7 produces visual output the agent cannot self-classify as compliant or non-compliant.
- An implementation step would touch code outside `grafcet_renderer.py` (e.g., a webapp service module). Confirm scope before extending.
- A single phase has been iterating for more than 5 visual review rounds without convergence.
- Test execution requires destructive shell operations (e.g., wiping cached output dirs); confirm first.

The agent MUST NOT pause for "phase boundary review" — autonomous continuation is the default unless a stop gate above applies.

## Execution-Ready Checklist

- [x] proposal.md authored
- [x] spec.md authored
- [x] design.md authored
- [x] data-schema.json authored
- [x] c4.json authored
- [x] sequence.json authored
- [x] idef0.json authored
- [x] grafcet.json authored (renderer-as-figure self-description)
- [x] tasks.md authored with phased structure
- [ ] test-vectors.json authored
- [ ] errors.md authored
- [ ] observability.md authored
- [ ] state promoted to `planned` via `plan-promote.ts --to planned`
- [ ] state promoted to `implementing` upon first task check

## Validation Evidence Capture

For each phase completion:

- Phase summary appended to session event log under `/home/pkcs12/projects/opencode/docs/events/event_<YYYYMMDD>_grafcet-renderer-overhaul.md`.
- Render log diff per figure (pre/post) captured if Phase 6 debug.log enabled.
- Visual review JSONL at `specs/grafcet-renderer-overhaul/visual_review.jsonl` with one entry per (figure, defect_id, status).

## Rollback Plan

- Per task: git stash + reset if individual edit breaks build.
- Per phase: git revert phase commit if integration test fails.
- Per overhaul: this spec's `.history/refactor-*` snapshot via `plan-rollback-refactor.ts` if the overhaul as a whole is abandoned.
