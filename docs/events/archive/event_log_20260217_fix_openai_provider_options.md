# Event: Fix `invalid openai provider options` (gpt-5.3-codex)

**Date**: 2026-02-17  
**Scope**: `llm.ts`, `transform.ts`, OpenAI request providerOptions path

## Symptom

- Runtime error in active session:
  - `AI_InvalidArgumentError: invalid openai provider options`
- Reproduced with source entrypoint (not binary):
  - `bun --conditions=browser ./packages/opencode/src/index.ts run --model openai/gpt-5.3-codex "hi"`

## Investigation Timeline

1. Confirmed the failure occurs at request option validation (`parseProviderOptions`) and not provider constructor init.
2. Verified provider-level options were already narrowed to `apiKey`/`fetch` during SDK creation.
3. Added temporary runtime print of request providerOptions for openai path.
4. Captured payload at failure time:
   - `{"openai":{"store":false,"promptCacheKey":"...","reasoningEffort":"medium","reasoningSummary":"auto","instructions":{}}}`
5. Root-cause identified:
   - `instructions` was a `Promise` object, serialized as `{}` and rejected by OpenAI provider options schema.

## Root Cause

- `SystemPrompt.instructions()` is async.
- Two call sites passed it without `await`, injecting non-string `instructions` into provider options:
  - `packages/opencode/src/session/llm.ts`
  - `packages/opencode/src/agent/agent.ts`

## Fix Implemented

1. Await async instructions at both call sites:
   - `packages/opencode/src/session/llm.ts`
   - `packages/opencode/src/agent/agent.ts`
2. Harden provider option mapping for OpenAI requests:
   - Strip SDK-constructor keys from request-level providerOptions.
   - Apply OpenAI request-key allowlist before sending.
   - File: `packages/opencode/src/provider/transform.ts`
3. Added targeted test:
   - Ensures request providerOptions removes constructor keys and unknown keys.
   - File: `packages/opencode/test/provider/transform.test.ts`

## Validation

- Command:
  - `bun --conditions=browser ./packages/opencode/src/index.ts run --model openai/gpt-5.3-codex "hi"`
- Result after fix:
  - Request succeeds and returns normal assistant response.
  - `AI_InvalidArgumentError: invalid openai provider options` no longer reproduced.

## Notes

- `bun run dev` requires an interactive TTY in this environment.
- Functional validation was executed through the same source runtime path without using the packaged binary.
