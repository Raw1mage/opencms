# Handoff

## Execution Contract
- Build agent must read implementation-spec.md first.
- Materialize tasks.md into runtime todos before coding.

## Required Reads
- implementation-spec.md
- proposal.md / spec.md / design.md 
- tasks.md

## Current State
- RCA completed. Deadlock identified at threshold triggering for legacy sessions.
- System is currently in a 440-message "Geology Hunt" for history.

## Stop Gates In Force
- Stop if SharedContext is empty (No fallback possible).

## Build Entry Recommendation
- Start with `message-v2.ts` defensive gate. This provides the most immediate stability.

## Execution-Ready Checklist
- [ ] Implementation spec is complete.
- [ ] Validation plan is explicit.
- [ ] Runtime todo seed is present in tasks.md.
