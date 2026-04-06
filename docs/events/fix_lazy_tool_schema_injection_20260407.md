# Fix: Lazy Tool Schema Injection (21K token bloat)

**Date**: 2026-04-07
**Type**: Bug fix
**Files changed**: `packages/opencode/src/session/prompt.ts`

## Problem

Lazy tool loading was completely defeated: `prompt.ts:1430-1451` re-added ALL lazy tools (with full schemas) back into the active `tools` dict before sending to the LLM. This injected ~21K tokens of unused tool schemas per request.

## Root Cause

Two competing mechanisms existed:
1. `prompt.ts` wrapped lazy tools and re-injected them into `tools` (upfront injection)
2. `llm.ts:experimental_repairToolCall` handled on-demand activation when the LLM attempted to call a missing tool

Mechanism #1 made #2 dead code, and sent all schemas regardless.

## Fix

- Removed the re-injection block at `prompt.ts:1430-1451`
- `lazyTools` map is still passed to `processor.process()` → `LLM.stream()`
- On-demand activation via `experimental_repairToolCall` in `llm.ts` now works as intended
- Removed unused `UnlockedTools` import from `prompt.ts`
