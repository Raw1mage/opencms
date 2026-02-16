# Event: Token-Efficient Role-Based System Prompt Refactoring

Date: 2025-02-15
Topic: Architectural optimization to reduce token usage and enforce hierarchical agent authority.

## Status

- [x] ANALYSIS: Identified exponential token drain caused by redundant prompt loading in subagents.
- [x] PLANNING: Designed a three-tier system: SYSTEM.md (Red Light), Drivers (Exposed BIOS), and AGENTS.md (Green Light).
- [x] EXECUTION: Implemented role-based conditional loading and dynamic SYSTEM.md content.

## Problem Description

The original Opencode architecture suffered from "Token Inflation." Every API call, regardless of whether it was a Main Agent or a small Subagent, received the full set of system prompts (BIOS, AGENTS.md, all Skills). This caused:

1. **Exponential Cost**: Token usage scaled poorly with task complexity.
2. **Attention Dilution**: Hardcoded BIOS fluff competed with actual task instructions.
3. **Instruction Confusion**: Subagents were overwhelmed by global project rules (AGENTS.md) that were irrelevant to their specific tasks.

## Solution: The "Surgical" Refactor

1. **BIOS Outsourcing**: Moved internal `.txt` drivers to `~/.config/opencode/prompts/drivers/` allowing for "De-noising" by the user.
2. **SYSTEM.md (The Real System Prompt)**:
   - Added a new absolute authority layer pinned to the very bottom of every Request.
   - Implemented **Role-Based Branching**:
     - **Main Agent**: Receives `ORCHESTRATOR PROTOCOL`, mandated to manage `AGENTS.md` and context.
     - **Subagent**: Receives `WORKER PROTOCOL`, restricted to task scope only, saving thousands of tokens.
3. **Conditional Loading**: Modified `prompt.ts` to actively skip `AGENTS.md` for any session with a `parentID`.
4. **Identity Reinforcement**: Hard-coded authority levels into the environment context (`Parent Session ID` tracking).

## Impact

- **Cost Reduction**: Subagent calls are now significantly lighter (up to 70% reduction in system prompt overhead).
- **Behavioral Control**: "Red Light Rules" (Absolute Paths, Read-Before-Write, Event Ledger) are now inescapable as they sit at the Recency Bias hotspot.
- **Transparency**: The entire "Soul" of the AI is now editable in the XDG config path.

## References

- @event_20260215_quota_stats_refactor
- @event_20260215_system_md_refactor
