# Handoff

## Execution Contract

- Build agent must read implementation-spec.md first
- Build agent must read proposal.md / spec.md / design.md / tasks.md before coding
- Materialize tasks.md into runtime todos before coding
- Preserve planner task naming in user-visible progress and runtime todo
- Prefer delegation-first execution when a task slice can be safely handed off
- Treat this plan as a consolidation-and-hardening contract, not a blank-sheet scheduler redesign

## Required Reads

- implementation-spec.md
- proposal.md
- spec.md
- design.md
- tasks.md

## Current State

- Planner clarification completed: this plan is explicitly scoped to 收斂現況.
- Existing evidence already indicates the following durability baseline is implemented or recently fixed: CronStore persistence, boot recovery, minute-level heartbeat, and `listenUnix()` lifecycle wiring.
- Remaining work is validation/hardening oriented, especially real daemon-path execution proof and regression coverage.

## Stop Gates In Force

- Preserve approval, decision, and blocker gates from implementation-spec.md
- Return to planning if a new implementation slice is not represented in planner artifacts
- Stop immediately if live runtime still shows missing run-log / execution-log evidence after due-job validation

## Build Entry Recommendation

- Start with the narrowest missing hardening slice: verify whether an integration/regression test is absent for `Server.listenUnix()` lifecycle startup, then execute live runtime smoke validation before expanding scope.

## Execution-Ready Checklist

- [ ] Implementation spec is complete
- [ ] Companion artifacts are aligned
- [ ] Validation plan is explicit
- [ ] Runtime todo seed is present in tasks.md
