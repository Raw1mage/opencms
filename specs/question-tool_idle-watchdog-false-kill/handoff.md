# Handoff: question-tool_idle-watchdog-false-kill

## Execution Contract

Implement DD-1 (option A pause hook). The bug is confirmed (daemon log); the
fix point is decided. Build phases 1→6 in order; phase 4 tests gate phase 6.

## Required Reads

Read these before touching code:


- `design.md` (this package) — DD-1, taxonomy, code anchors
- `packages/opencode/src/session/llm.ts:1762-1830` — watchdog arm/disarm + onChunk
- `packages/opencode/src/session/llm.ts:2115-2119` — tools + composedAbortSignal
- `packages/opencode/src/tool/tool.ts:25-53` — Tool.Context
- `packages/opencode/src/tool/question.ts` — full file (57 lines)
- `packages/opencode/src/question/index.ts:133-200` — ask/onAbort (read-only)

## Stop Gates In Force

- If injecting `pauseIdleWatchdog` into ctx requires changing where tool ctx is
  constructed in a way that touches other tools' behavior → STOP, re-evaluate
  blast radius (may need `extend`).
- If AI SDK's tool ctx is not the same object as `Tool.Context` (adapter layer)
  → STOP, confirm the real ctx wiring before proceeding.

## Execution-Ready Checklist

- [x] RCA confirmed (daemon log)
- [x] Fix point decided (DD-1, option A)
- [x] Test vectors defined (test-vectors.json)
- [x] Critical files + anchors listed (design.md)
- [ ] Build not yet started

## Validation

- `bun test packages/opencode/test/` — phase-4 tests green
- Manual: trigger a `question`, wait > 90s, confirm it is NOT retracted
- Confirm a genuine stop (killswitch) still interrupts a pending question
