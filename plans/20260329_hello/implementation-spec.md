# Implementation Spec

## Goal
- <one-sentence execution objective>

## Scope
### IN
- <in scope>

### OUT
- <out of scope>

## Assumptions
- <assumption>

## Stop Gates
- <approval / decision / blocker conditions>
- <when to stop and re-enter planning>

## Critical Files
- <absolute or repo-relative file paths>

## Structured Execution Phases
- <phase 1: planner / runtime contract rewrite>
- <phase 2: delegated execution / integration slice>
- <phase 3: validation / documentation sync>

## Validation
- <tests / commands / end-to-end checks>
- <operator or runtime verification>

## Handoff
- Build agent must read this spec first.
- Build agent must read   proposal.md / spec.md / design.md / tasks.md / handoff.md before coding.
- Build agent must materialize runtime todo from tasks.md and preserve planner task naming.
- Build agent must prefer delegation-first execution when the task slice can be safely handed off.
