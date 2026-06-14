# Bug Report: `question` tool prompt retracted mid-answer and treated as answered, agent advances

## Summary

While the user was still composing an answer to a `question` (MCP) tool prompt, the runtime retracted the question and the agent proceeded to the next step as if the question had already been answered. The user lost the chance to make the bounded decision the agent had explicitly paused for.

Observed live in this session: two consecutive `question`-terminated turns were interrupted with `[Tool execution was interrupted]`, and on the following turn the agent continued its plan without the user's actual selection.

## Environment

- Date: 2026-05-30
- Repo: `/home/pkcs12/projects/opencode`
- Tool: `question` MCP tool (`packages/opencode/src/tool/question.ts` → `packages/opencode/src/question/index.ts`)
- Agent role: Main Agent / orchestrator
- Provider in use at time of incident: claude
- Related: this is adjacent to (but distinct from) `issues/bug_20260529_claude_assistant_prefill_400.md` — both involve a `question`-terminated turn followed by a continuation.

## Impact

- A deliberate decision gate (the whole point of the `question` tool) is silently bypassed.
- The agent advances on an assumed/empty answer instead of waiting, defeating the "stop for product decision" contract.
- User intent is lost: the bounded choice the agent asked for is never actually collected.
- Erodes trust in the `question` tool as a real pause point — the user cannot rely on the agent waiting.

## Evidence

- `packages/opencode/src/question/index.ts:164-179` — on abort, `Question.ask` runs `onAbort`, deletes the pending entry, publishes `question.rejected`, and `reject(new RejectedError("aborted: ..."))`. The reject path is correct in isolation: it does NOT fabricate an answer.
- `packages/opencode/src/tool/question.ts:34-55` — the tool's `execute` has **no try/catch** around `Question.ask`. A `RejectedError` propagates upward as a thrown tool error; the success-path output (`"User has answered your questions: ..."`) is only produced when `ask` resolves normally.
- `packages/opencode/src/session/message-v2.ts:1107-1115` — when a tool call part is still `pending`/`running` at conversation-rebuild time, it is rewritten to `state: "output-error"` with `errorText: "[Tool execution was interrupted]"` so that Anthropic's "every tool_use needs a tool_result" invariant holds.
- `packages/opencode/src/tool/question.ts:42-44` — `format(undefined)` returns `"Unanswered"`. This only matters on the resolve path; the abort path never reaches it.

## Root Cause (CONFIRMED — v3, via daemon log + code chain)

**Status:** Resolved via `plans/question-tool_idle-watchdog-false-kill/` (see commit log).

### RCA correction history (for audit)

The original write-up of this report contained two incorrect Root Cause
hypotheses. They are preserved below as `(v1)` and `(v2)` so future
reviewers can see why they were wrong; the **confirmed** cause is `(v3)`.

- **(v1, WRONG)** "A new user message / session interrupt fires the session
  abort signal while the question is pending." — Refuted by the user:
  "I didn't interrupt it, I was typing." With no new user message there
  is no session interrupt to fire.
- **(v2, WRONG)** "Frontend SSE reconnect (visibilitychange / online /
  bfcache) cascades into `SessionPrompt.cancel`." — Refuted by reading
  `packages/opencode/src/session/prompt-runtime.ts:15-25`: `CancelReason`
  is a closed enum (`replace` | `monitor-watchdog` | `rate-limit-fallback`
  | `killswitch` | `instance-dispose`); no SSE/reconnect reason exists,
  and the frontend `reconnect()` aborts a *separate* EventSource
  AbortController, not the SessionPrompt one.
- **(v3, CONFIRMED)** The 90s **stream-idle watchdog** in `LLM.stream`
  (`packages/opencode/src/session/llm.ts:1768` `STREAM_IDLE_TIMEOUT_MS = 90_000`)
  fires while the user is typing because no LLM token chunks flow during
  the wait, so `armIdleWatchdog`'s `onChunk` re-arm never triggers. At 90s
  `idleController.abort(new Error("stream idle timeout after 90000ms"))`
  fires; that signal joins the merged `composedAbortSignal`
  (`AbortSignal.any([input.abort, idleController.signal])`,
  `llm.ts:2119`); AI SDK forwards the merged signal into the
  tool's `ctx.abort`; `question/index.ts:179` runs `onAbort` and rejects
  with `RejectedError("aborted: stream idle timeout after 90000ms")`.

### Decisive log evidence

```
[question] aborted reason="stream idle timeout after 90000ms"
  durationMs:90207
  stack: QuestionRejectedError at question/index.ts:179
         ← abort ← llm.ts:1792
```

`durationMs:90207` ≈ `STREAM_IDLE_TIMEOUT_MS` (90,000) → the watchdog
fired exactly when designed; the design just didn't anticipate that an
interactive tool legitimately awaits humans with no token flow.

### Why the model interpreted the interrupted tool_result as "done"

Independently of the abort cause, the downstream display path
(`message-v2.ts:1107-1115` rewrites pending tool calls to
`[Tool execution was interrupted]`) is generic: no `question`-specific
"decision not made" signal. So even after the false-abort, the model
sees the same generic interrupt text it would see for an interrupted
file read, and proceeds.

### Fix shipped (plans/question-tool_idle-watchdog-false-kill DD-1)

Added `Tool.Context.pauseIdleWatchdog?: () => () => void` (typed hook).
`LLM.stream` builds the watchdog, publishes a `pauseIdleWatchdog` closure
that disarms the idle timer and returns an idempotent `resume()`. The
hook flows through `StreamInput.idleWatchdogBox` →
`ResolveToolsInput.idleWatchdogBox` → `ToolInvoker.InvokeOptions.pauseIdleWatchdog`
→ `Tool.Context.pauseIdleWatchdog`. `tool/question.ts` wraps `Question.ask`
in `const resume = ctx.pauseIdleWatchdog?.(); try { ... } finally { resume?.() }`,
so the watchdog cannot false-kill a typing user. Genuine `input.abort`
(killswitch / manual-stop / session-switch / instance-dispose) still
rejects normally — only the idle branch is suspended. First-chunk
watchdog is unaffected (fires before any tool runs).

Regression tests TV-1..TV-4 in
`packages/opencode/test/tool/question.test.ts` cover pause-before-ask,
resume-on-throw, optional-chaining no-op (backwards compat), and resume
idempotency. All green at fix time (6 pass / 0 fail).

## Reproduction (observed)

1. Agent calls the `question` tool to gate a bounded decision; the turn ends awaiting a user answer.
2. User begins answering but the answer is not yet submitted (or a new user message / continuation arrives first).
3. The pending `question` is aborted; its tool call is rewritten to `[Tool execution was interrupted]`.
4. On the next turn the agent proceeds with its plan as if the question were resolved, without the user's actual selection.

## Expected Behavior

- A `question` that is interrupted before the user submits an answer must NOT be treated as answered or resolved. The agent must either:
  - re-issue the same question, or
  - explicitly surface "the previous question was not answered — here are the options again" and wait, or
  - treat the interruption as an explicit stop gate and pause for the user.
- An interrupted/rejected `question` must be clearly distinguishable downstream from an answered one, so the model does not read `[Tool execution was interrupted]` as a terminal "done" signal for the decision.
- The decision gate must be preserved: bypassing a `question` the agent itself raised is a contract violation (SYSTEM.md §2.7 / §16.5 stop-gate semantics).

## Actual Behavior

- The interrupted `question` is stamped as an errored tool_result and the conversation moves on.
- The model interprets the errored/interrupted tool_result as the question being concluded and advances.
- The user's intended decision is never collected; the agent acts on an assumed path.

## Suspected Causes

1. **No explicit "re-ask on interrupt" semantics.** `tool/question.ts` has no try/catch and no policy to re-issue or hard-pause when `Question.ask` rejects due to abort.
2. **Interrupt-rewrite ambiguity.** `message-v2.ts:1107-1115` uses the same generic `[Tool execution was interrupted]` error text for the `question` tool as for any other tool. For most tools "interrupted" is fine; for `question` it erases a decision gate. The model cannot tell "interrupted file read (safe to skip)" from "interrupted decision gate (must re-ask)".
3. **Continuation races the pending question.** A new user message / autonomous continuation can advance the conversation while a `question` is still pending, aborting it. The pending decision is not re-queued.

## Acceptance Criteria

- An interrupted/rejected `question` (RejectedError due to abort) is NOT rendered to the model as a resolved/answered question.
- Either: (a) the runtime re-issues the pending `question` on the next turn, or (b) the model receives an unambiguous "DECISION NOT MADE — re-ask required" signal distinct from the generic interrupted-tool text, or (c) a pending `question` blocks/serializes against a new continuation so it cannot be silently dropped.
- A regression test covers: a `question` aborted while pending → assert the downstream tool_result/state is NOT interpreted as answered (no `"User has answered your questions"` output, and a distinguishable re-ask/pending marker is present).
- Per AGENTS.md天條 (no silent fallback): the interrupt must be explicit and observable, not a silent advance on an empty/assumed answer.

## Next-Session Checklist

- Read the interrupt source path end-to-end (`session/prompt.ts` / `session/prompt-runtime.ts` interrupt handler) to confirm the exact trigger that aborts a pending `question` when a new user message arrives. Close the inference gap noted in Root Cause.
- Decide the fix surface: (a) re-ask policy in `tool/question.ts`, (b) `question`-specific interrupt text in `message-v2.ts:1107-1115`, or (c) serialize pending `question` against continuations in the runloop. Prefer the option that keeps the decision gate intact with the least blast radius.
- Add the regression test described in Acceptance Criteria.
- Cross-check interaction with the autonomous-continuation contract (SYSTEM.md §9 / §2.7): a pending `question` should suppress autonomous continuation until answered or explicitly dismissed.
- Verify the claude-specific angle: does the interrupted `question` tool_result contribute to the trailing-assistant / prefill-400 family (bug_20260529)? The two may share the "question-terminated turn + continuation" trigger.
