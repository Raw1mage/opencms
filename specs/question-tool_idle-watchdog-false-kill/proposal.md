# Proposal: question-tool_idle-watchdog-false-kill

## Why

The `question` MCP tool is the canonical decision-gate: the agent pauses and
waits for a human answer. A user reported that while still typing an answer —
without submitting anything, without interrupting — the question was retracted
and the agent advanced as if it had been answered.

Daemon-log RCA (debug.log seq 9681, 2026-05-30) proves the cause is NOT a new
user message and NOT an SSE reconnect. It is the **stream-idle watchdog**
(`llm.ts:1768`, `STREAM_IDLE_TIMEOUT_MS = 90_000`) firing during the
`question` tool's wait:

```
[question] aborted reason="stream idle timeout after 90000ms" durationMs:90207
  QuestionRejectedError at question/index.ts:179 ← abort ← llm.ts:1792
```

The watchdog exists to detect provider 0-byte stream wedge (incident 2026-05-19
codex 193K eviction; 2026-05-26 first-chunk hang). It re-arms only on token
chunk arrival (`onChunk → armIdleWatchdog`). During a `question` wait no chunks
flow, so the 90 s timer is never reset and aborts the whole stream — taking the
pending question with it. The watchdog cannot distinguish "stream wedged" from
"tool legitimately awaiting a human".

## Original Requirement Wording (Baseline)

- "我正在打字回答它，就突然被關掉然後繼續後續動作了"
- "我沒有中斷它。我正在打字回答它"
- "完整提出一個處理方案，用 plan 的，比較嚴謹"

## Requirement Revision History

- 2026-05-30: initial draft created via plan_create
- 2026-05-30: RCA corrected twice during investigation — (v1) "new user message
  triggers abort" [WRONG, refuted by user "I was only typing"]; (v2) "SSE
  reconnect cascades to SessionPrompt.cancel" [WRONG, CancelReason is a closed
  set excluding reconnect]; (v3, CONFIRMED via daemon log) "90 s stream-idle
  watchdog fires during question wait". This proposal records only v3.

## Effective Requirement Description

1. A `question` tool that is awaiting a human answer MUST NOT be killed by the
   stream-idle watchdog. The user must be able to take an arbitrarily long time
   to answer without the decision gate being silently retracted.
2. The watchdog's legitimate purpose (detecting provider 0-byte stream wedge)
   MUST be preserved — it cannot simply be disabled.
3. Genuine user/session aborts (killswitch, manual-stop, session-switch,
   instance-dispose) MUST still interrupt a pending question.

## Scope

### IN
- The stream-idle watchdog in `LLM.stream` (`packages/opencode/src/session/llm.ts`)
- The `question` tool execution path (`packages/opencode/src/tool/question.ts`)
- The `Tool.Context` interface if a pause/resume hook is required
  (`packages/opencode/src/tool/tool.ts`)
- Regression tests for the watchdog-vs-interactive-tool interaction

### OUT
- The separate `bug_20260529_claude_assistant_prefill_400` fix (already landed)
- The cache-cliff false-positive issue for claude (tracked separately)
- The streaming "一截一截" rendering UX (presentation-layer, separate)
- Any change to the first-chunk watchdog's purpose (only its interaction with
  interactive tools is in scope)

## Non-Goals

- Removing or weakening 0-byte wedge detection
- Changing the 90 s / 60 s timeout constants themselves
- Re-architecting the AI-SDK tool-call loop

## Constraints

- AI SDK `ai` v5 series (`@ai-sdk/provider 2.0.1`). `streamText` exposes
  `onChunk` / `onStepFinish` / `onFinish` / `onError`; there is NO
  `onToolCallStart` hook. Any "pause watchdog during tool execute" mechanism
  must work within these hooks or inside the tool itself.
- `ctx.abort` delivered to a tool is the ALREADY-MERGED
  `AbortSignal.any([input.abort, idleController.signal])` (`llm.ts:2119`,
  `tool.ts:33`). A tool cannot distinguish idle-abort from real abort at the
  signal level — the fix cannot live purely inside `question.ts` reading
  `ctx.abort`.
- No silent fallback (AGENTS.md天條): the fix must be explicit and observable.

## What Changes

- The idle watchdog gains a pause/resume capability so it does not count down
  while an interactive tool (`question`, and by extension `permission`) is
  awaiting human input.

## Capabilities

### New Capabilities
- watchdog-pause-during-interactive-tool: the stream-idle countdown is
  suspended for the duration of an interactive tool's wait, then resumed.

### Modified Capabilities
- question tool: no longer killed by idle timeout while awaiting an answer;
  still killed by genuine user/session abort.

## Impact

- `packages/opencode/src/session/llm.ts` — watchdog pause/resume
- `packages/opencode/src/tool/question.ts` — invoke pause around `Question.ask`
- `packages/opencode/src/tool/tool.ts` — possibly add pause hook to `Tool.Context`
- `issues/bug_20260530_question_tool_retracted_treated_as_answered.md` — Root
  Cause section must be corrected (currently records the refuted v1 hypothesis)
- New regression test under `packages/opencode/test/`
</parameter>
</invoke>
