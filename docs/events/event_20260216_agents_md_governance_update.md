# Event: Update AGENTS.md with Tool Governance and Dispatch Standards

**Date:** 2026-02-16
**Topic:** agents-md-governance-update

## Summary

Updated `AGENTS.md` to include formal rules for tool usage and Subagent dispatching. This addresses the recent `invalid arguments` error caused by tool parameter confusion.

## Changes

- **Added Section 6 (Tool Governance)**: Defined Primary (`default_api:*`) vs Specialized (`filesystem_*`) toolchains.
- **Added Section 7 (Subagent Dispatch Standards)**: Created an injection template for `Task()` prompts to enforce strict tool usage rules on Subagents.

## Rationale

To prevent "Tool Collision" (mixing parameters between similar tools) and ensure all Subagents adhere to the project's security and auditing protocols (Read-Before-Write).
