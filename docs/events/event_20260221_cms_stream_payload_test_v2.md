# Event: CMS stream payload test matrix v2 (initial)

- **Date**: 2026-02-21
- **Status**: Done
- **Scope**:
  - `packages/opencode/test/session/llm-cms-stream.test.ts` (new)

## Objective

Start rebuilding stream payload coverage on cms-native provider assumptions.

## Changes

1. Added new test file `llm-cms-stream.test.ts`.
2. Implemented deterministic local HTTP capture server for payload assertions.
3. Added cms-native stream test using a custom openai-compatible provider (`cms-openai`) declared in test config:
   - validates outbound endpoint contract (`/chat/completions`)
   - validates auth header propagation
   - validates model id mapping and stream flag
   - validates token-limit field presence (`max_tokens` or `max_output_tokens`)

## Validation

- `bun test packages/opencode/test/session/llm-cms-stream.test.ts` → pass
- Combined cms-aligned suites:
  - config / permission / agent / provider-cms / llm-cms-stream
  - **118 pass, 0 fail**

## Next

1. Add cms-native stream tests for additional active families (google / gemini-cli path where feasible).
2. Add negative-path assertions (invalid key / 4xx mapping) with deterministic local fixtures.
3. Gradually migrate high-value legacy `session.llm.stream` scenarios into cms-native suite.
