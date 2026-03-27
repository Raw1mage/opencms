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

## Current State
- RCA is complete: provider list currently aggregates observed provider keys instead of consuming a repo-owned SSOT.
- The approved planning direction is to use a formal supported-provider set, not a broad runtime-observed set.
- The initial planned supported-provider list is: `openai`, `claude-cli`, `google-api`, `gemini-cli`, `github-copilot`, `gmicloud`, `openrouter`, `vercel`, `gitlab`, `opencode`.

## Stop Gates In Force
- Stop if execution reveals a provider in active product use that is absent from the approved supported-provider list.
- Stop if a hidden runtime-only provider must remain visible for product reasons.
- Return to planning if a new canonical provider needs to be added or removed from the registry.

## Build Entry Recommendation
- Start by creating the canonical provider registry and wiring `canonical-family-source.ts` / `/provider` route to it before touching UI consumers.

## Execution-Ready Checklist
- [ ] Implementation spec is complete
- [ ] Companion artifacts are aligned
- [ ] Validation plan is explicit
- [ ] Runtime todo seed is present in tasks.md
