# Handoff

## Execution Contract

- Build agent must read implementation-spec.md first
- Build agent must read proposal.md / spec.md / design.md / tasks.md before coding
- Materialize tasks.md into runtime todos before coding

## Required Reads

- implementation-spec.md
- proposal.md
- spec.md
- design.md
- tasks.md

## Current State

- Plan package complete, no implementation started
- Gmail MCP server already upgraded with htmlToText and markdown table output (separate prior fix)
- mcp-separation Step 4 (settings UI, auth flow) is complete on main

## Stop Gates In Force

- SG-1: Non-directRender tools must behave identically (zero regression)
- SG-2: Model must never receive >200 tokens for a direct-rendered result
- SG-3: fullOutput cap at 64KB

## Build Entry Recommendation

Start with Phase 1 task 1.4 (resolve-tools.ts interception) — this is the core mechanism. Tasks 1.1-1.3 are schema scaffolding that can be done quickly first. Phase 2 (UI) depends on Phase 1 being testable.

Key file to study first: `packages/opencode/src/session/resolve-tools.ts` lines 221-303 — this is where MCP tool results are normalized. The interception point is after result text is extracted but before it's returned to the AI SDK.

## Execution-Ready Checklist

- [x] Implementation spec is complete
- [x] Companion artifacts are aligned
- [x] Validation plan is explicit
- [x] Runtime todo seed is present in tasks.md
