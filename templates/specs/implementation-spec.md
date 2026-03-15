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

- <phase 1>
- <phase 2>
- <phase 3>

## Validation

- <tests / commands / end-to-end checks>
- <operator or runtime verification>

## Handoff

- Build/implementation agent must read this spec first.
- Build/implementation agent must read `tasks.md` and materialize runtime todo from it before coding.
- Conversation memory is supporting context only, not the execution source of truth.
- If scope changes or a new slice appears, update the same plan root unless a new plan is explicitly user-approved.
- At completion time, review implementation against the proposal's effective requirement description.
