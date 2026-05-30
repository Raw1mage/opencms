# Design: question-tool_idle-watchdog-false-kill

## Context

The stream-idle watchdog in `LLM.stream` aborts a streamText call if no token
chunk arrives within 90s, to recover from provider 0-byte wedge. It cannot
distinguish "stream wedged" from "an interactive tool is legitimately awaiting
a human", so it kills pending `question` (and would kill `permission`) waits.

## RCA (traceability — confirmed via daemon log, not inference)

Causal chain (each link evidenced):

1. `llm.ts:1768` — `STREAM_IDLE_TIMEOUT_MS = 90_000`; watchdog re-arms only on
   `onChunk` (`llm.ts:1830`).
2. `question` tool executes inside the streamText multi-step loop; while
   awaiting the user, no chunks flow → watchdog never re-armed.
3. `llm.ts:1792` — at 90s `idleController.abort(new Error("stream idle timeout
   after 90000ms"))`.
4. `llm.ts:2119` — `composedAbortSignal = AbortSignal.any([input.abort,
   idleController.signal])` is the streamText `abortSignal`; AI SDK forwards it
   into each tool's `ctx.abort`.
5. `question/index.ts:179` — `onAbort → reject(RejectedError("aborted: stream
   idle timeout after 90000ms"))`. Question retracted.

Log proof (debug.log seq 9681, 2026-05-30):
`[question] aborted reason="stream idle timeout after 90000ms" durationMs:90207`,
stack `question/index.ts:179 ← abort ← llm.ts:1792`.

### RCA correction history (for auditability)

- v1 (WRONG): "new user message triggers session interrupt" — refuted by user:
  "I didn't interrupt it, I was typing".
- v2 (WRONG): "SSE reconnect cascades to SessionPrompt.cancel" — refuted:
  `CancelReason` is a closed set (`prompt-runtime.ts:15-25`) excluding any
  reconnect reason; frontend reconnect aborts only the SSE stream, a separate
  AbortController.
- v3 (CONFIRMED, this design): 90s stream-idle watchdog. Confirmed by daemon log.

## Goals / Non-Goals

### Goals
- Pause the idle countdown while an interactive tool awaits human input.
- Resume it afterward so wedge detection still works for later stream segments.
- Keep genuine `input.abort` able to interrupt a pending question.

### Non-Goals
- Removing/weakening 0-byte wedge detection.
- Changing the 90s / 60s constants.
- Re-architecting the AI-SDK tool loop.

## Decisions

- **DD-1** Fix point = **Context pause hook (option A)**, chosen by user
  ("照建議做"). `Tool.Context` gains an optional
  `pauseIdleWatchdog?: () => () => void`. `LLM.stream` injects an implementation
  that disarms the idle timer and returns a `resume` closure that re-arms it.
  `question.ts` wraps `Question.ask` in `const resume = ctx.pauseIdleWatchdog?.();
  try { ... } finally { resume?.() }`.
  - Rejected option B (interactive-tool whitelist in watchdog): AI SDK exposes
    no reliable "currently-executing tool" hook; would need fragile step
    tracking.
  - Rejected option C (re-arm on `onStepFinish`): step boundary fires only
    after the tool returns; the 90s fires *during* the step, before
    onStepFinish — does not solve the race.
  - Why not "tool reads `input.abort` only": `ctx.abort` is the already-merged
    `AbortSignal.any([input.abort, idleController.signal])` (`tool.ts:33`); the
    tool cannot separate idle-abort from real abort at signal level. The fix
    must live where the unmerged signals exist — `LLM.stream`.

- **DD-2** No silent fallback (AGENTS.md天條). `pauseIdleWatchdog` is explicit;
  when absent (e.g. small-model path that doesn't inject it) the tool behaves
  as today (optional-chaining no-op) — this is acceptable because it does not
  mask a defect, it just leaves the pre-fix behavior on a path the bug never
  affected.

## Taxonomy (per code-thinker §4)

- **`pauseIdleWatchdog`** (Tool.Context optional method)
  - Is: a hook an interactive tool calls to suspend the stream-idle countdown.
  - Input: none.
  - Output: a `resume: () => void` closure that re-arms the idle watchdog.
  - MUST NOT be read as: cancelling the whole stream abort; disabling
    `input.abort`; pausing the first-chunk watchdog (that fires before any tool
    runs, so it is out of scope).
  - Done when: idle timer does not fire between `pauseIdleWatchdog()` and
    `resume()`; after `resume()` the timer counts down from full again.

## Risks / Trade-offs

- **R1** If a tool calls `pauseIdleWatchdog()` and never calls `resume()` (throws
  without finally), the watchdog stays disarmed for the rest of the stream →
  wedge detection lost for that turn. Mitigation: mandatory `try/finally` in the
  tool; resume in finally.
- **R2** Concurrent interactive tools in one step (not currently possible — one
  question at a time) could double-pause. Mitigation: ref-count or idempotent
  disarm. Low priority (no current caller does this).

## Critical Files

- `packages/opencode/src/session/llm.ts` — watchdog arm/disarm, ctx injection
- `packages/opencode/src/tool/tool.ts` — `Tool.Context` interface
- `packages/opencode/src/tool/question.ts` — wrap `Question.ask`
- `packages/opencode/src/question/index.ts` — (read-only; reject path unchanged)

## Code anchors

- `packages/opencode/src/session/llm.ts:1768` STREAM_IDLE_TIMEOUT_MS
- `packages/opencode/src/session/llm.ts:1782` armIdleWatchdog
- `packages/opencode/src/session/llm.ts:1795` disarmIdleWatchdog
- `packages/opencode/src/session/llm.ts:2119` composedAbortSignal
- `packages/opencode/src/tool/tool.ts:33` ctx.abort (merged signal)
- `packages/opencode/src/tool/question.ts:35` Question.ask call
- `packages/opencode/src/question/index.ts:179` reject on abort
