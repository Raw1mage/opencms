# Handoff

## Execution Contract
- Build agent must read implementation-spec.md first.
- Build agent must read proposal.md / spec.md / design.md / tasks.md before coding.
- Materialize tasks.md into runtime todos before coding.
- Preserve planner task naming in user-visible progress and runtime todo.
- Prefer delegation-first execution for bounded slices, but do not delegate documentation sync.
- Do not add fallback routing, default user selection, or silent attach fallback.

## Required Reads
- implementation-spec.md
- proposal.md
- spec.md
- design.md
- tasks.md
- `daemon/opencode-gateway.c`
- `docs/events/event_20260319_daemonization.md`
- `specs/architecture.md`

## Current State
- Existing gateway implementation is prototype-grade: PAM/login/adopt/spawn/splice skeleton exists.
- Planner contract is now partially locked: `--attach` = explicit auto-spawn; JWT current reality = `sub` + `exp`; uid strategy remains a controlled build-time decision within the hardening contract.
- Known gaps before hardening: JWT claim validation incomplete, routing still demo-based, old docs still contain attach drift, runtime verification incomplete.
- This plan package is the execution contract for closing those gaps.

## Stop Gates In Force
- Stop if JWT issuance payload and desired routing contract do not match current code reality.
- Stop if uid strategy cannot be safely resolved as either signed `uid` claim or controlled `sub`→uid lookup without expanding auth surface.
- Stop if runtime verification requires unavailable privileges/environment; record deferred evidence instead of faking completion.
- Stop and re-plan if implementation would alter core gateway/per-user daemon boundaries.

## Build Entry Recommendation
- Start from planner-refinement leftovers in Tasks 0.4 and the build-time resolution implied by 0.1: freeze the verification matrix and lock the uid strategy.
- Then move into Task 1.1 and Task 1.2 in `daemon/opencode-gateway.c`.

## Execution-Ready Checklist
- [x] Implementation spec is complete
- [x] Companion artifacts are aligned
- [x] Validation plan is explicit
- [x] Runtime todo seed is present in tasks.md
