# Errors — question-tool-abort-fix

## Error Catalogue

- **QUESTION_ABORTED** — pending question was aborted by stream signal (not manual reject)
  - **Message**: internal — `Question.RejectedError` with cause tagged `abort:<reason>`
  - **Status**: n/a (promise rejection, not HTTP)
  - **Trigger**: `Question.ask` bound AbortSignal fires while pending
  - **Recovery**: processor catches via `instanceof Question.RejectedError` → sets `blocked = shouldBreak` path (existing). LLM sees aborted tool part on next stream and may re-call the tool (which is fine — QuestionDock cache will restore input).
  - **Layer**: `packages/opencode/src/question/index.ts`

- **QUESTION_REPLY_FOR_UNKNOWN** — reply received for a pending entry that was already removed
  - **Message**: `log.warn("reply for unknown request", { requestID })` (existing behavior, not new)
  - **Status**: n/a (HTTP 200 still returned to client for idempotency)
  - **Trigger**: user hits Submit after `question.rejected` was already auto-published by abort handler
  - **Recovery**: no-op; the question is already resolved. The new `request.id` (if AI re-asked) gets answered next.
  - **Layer**: `packages/opencode/src/question/index.ts`

- **QUESTION_REJECT_FOR_UNKNOWN** — explicit reject for a pending entry already removed
  - **Message**: `log.warn("reject for unknown request", { requestID })` (existing)
  - **Status**: n/a (HTTP 200)
  - **Trigger**: client race — user clicks Dismiss after abort handler already rejected
  - **Recovery**: no-op
  - **Layer**: `packages/opencode/src/question/index.ts`

- **CANCEL_REASON_REQUIRED** — compile-time error when caller forgets to pass reason
  - **Message**: TypeScript `Expected 2 arguments, but got 1. An argument for 'reason' was not provided.`
  - **Status**: build-time, never reaches runtime
  - **Trigger**: any caller of `SessionPrompt.cancel` / `prompt-runtime.cancel` not passing reason
  - **Recovery**: add reason argument from `CancelReason` enum
  - **Layer**: TypeScript type check

- **HASH_UNAVAILABLE** — SubtleCrypto absent on current context (SSR / non-secure origin)
  - **Message**: internal — silent fallback to FNV-1a
  - **Status**: n/a (warn only, not user-facing)
  - **Trigger**: `crypto.subtle === undefined` or `digest()` throws at runtime
  - **Recovery**: use FNV-1a hash of canonical JSON; `console.warn("[question-dock] SubtleCrypto unavailable, using FNV-1a fallback")` once per session
  - **Layer**: `packages/app/src/components/question-dock.tsx`
  - **Note**: This is allowed as graceful degradation per AGENTS.md §1 ("WebSocket → HTTP fallback" pattern); the warn log makes it visible.

## Error Code Format

- UPPER_SNAKE_CASE, domain-prefixed (`QUESTION_*`, `CANCEL_*`, `HASH_*`)
- Codes are stable; messages may be revised (with supersede marker in history)
- Promise-rejection errors continue to use `Question.RejectedError` instanceof contract — do not introduce new error classes

## Recovery Strategies

| Strategy | Applies to | How |
|---|---|---|
| idempotent no-op | `QUESTION_REPLY_FOR_UNKNOWN`, `QUESTION_REJECT_FOR_UNKNOWN` | warn log + return success to client |
| existing blocked-path | `QUESTION_ABORTED` | processor `instanceof RejectedError` already sets `blocked = shouldBreak` |
| compile-time gate | `CANCEL_REASON_REQUIRED` | TypeScript required parameter |
| graceful degradation with log | `HASH_UNAVAILABLE` | FNV-1a fallback with one-time console.warn |
