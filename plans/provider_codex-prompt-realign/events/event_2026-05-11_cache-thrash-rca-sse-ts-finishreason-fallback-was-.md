---
date: 2026-05-11
summary: "Cache thrash RCA — sse.ts finishReason fallback was killing chain on every turn"
---

# Cache thrash RCA — sse.ts finishReason fallback was killing chain on every turn

## Symptom

Even after the index-0 hotfix, `cached_tokens` mostly stuck at 4608 (tools-only floor), with one turn jumping to 50688 right after each `prev=false` chain reset, then immediately falling back to 4608 on the next turn. WS REQ logs showed alternating `delta=true ↔ delta=false` instead of the expected steady-state `delta=true` after chain establishment.

## RCA

Independent issue from wire structure. `[DIAG:empty-response]` events showed turns where:

- text was emitted (`text="IDEF0 schema 需要明確標記..."`)
- responseMessages=1 (server returned a message)
- toolCalls=0
- **finishReason=unknown**

That's a contradiction: model produced output but stream-finish reason is "unknown". Root cause in `packages/opencode-codex-provider/src/sse.ts:252-255`:

```ts
let finishReason = state.finishReason === "stop" && state.hasFunctionCall
  ? "tool-calls"
  : (state.finishReason ?? "unknown")
```

When the upstream `response.completed` SSE event doesn't arrive (transport edge case — WS close between content frame and terminal event, or upstream introduced a new event type the parser doesn't map), `state.finishReason` stays null and the fallback is "unknown" **regardless of whether content was emitted**.

`prompt.ts` `isEmptyRound` predicate then matches: `(finish === "unknown") && tokens.input === 0 && tokens.output === 0` → fires `invalidateContinuationFamily` → kills the codex chain → next turn `delta=false`. Cache rebuilds, hits ~50k once, next misclassified turn kills it again → 4608 floor.

## Fix

`packages/opencode-codex-provider/src/sse.ts` — three-tier fallback:

1. Terminal event arrived → use `state.finishReason` (promote "stop"+function_call to "tool-calls")
2. No terminal event but content emitted (text or tool) → default to `"stop"` / `"tool-calls"`
3. No terminal event AND no content → `"unknown"` (legitimately empty, runloop guard should engage)

Pre-fix the path #2 collapsed into #3, treating successful turns as empty whenever the terminal event was missed.

## Verification

```
sse.test.ts                 23 pass / 0 fail
typecheck                   no new errors
```

User must re-run a turn post-restart and observe USAGE log; expect cached_tokens to GROW across consecutive turns instead of bouncing 4608 ↔ 50k.

## Caveats

- The underlying transport edge case (why response.completed sometimes doesn't arrive) is NOT fixed; just the misclassification of turns when it doesn't. If you want to root-cause the missing event itself, dig into ws.onclose path between content frame and terminal — likely a race or a new upstream event type.
- This is technically out of `provider/codex-prompt-realign` scope (it's a stream-parsing bug, not a wire-structure bug). Logged here because cache observability ties them together: the wire realign was correct, but the cache thrash RCA dragged us into the parser.

