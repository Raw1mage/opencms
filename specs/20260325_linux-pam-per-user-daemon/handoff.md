# Handoff

## Execution Contract
- Build agent must read implementation-spec.md first
- Build agent must read proposal.md / spec.md / design.md / tasks.md before coding
- Materialize tasks.md into runtime todos before coding
- Preserve planner task naming in user-visible progress and runtime todo
- Prefer delegation-first execution when a task slice can be safely handed off

## Required Reads
- implementation-spec.md
- proposal.md
- spec.md
- design.md
- tasks.md

## Stop Gates In Force
- Preserve approval, decision, and blocker gates from implementation-spec.md
- Return to planning if a new implementation slice is not represented in planner artifacts

## Execution-Ready Checklist
- [ ] Implementation spec is complete
- [ ] Companion artifacts are aligned
- [ ] Validation plan is explicit
- [ ] Runtime todo seed is present in tasks.md
