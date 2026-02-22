# Event: CMS google stream contract test unskipped

- **Date**: 2026-02-21
- **Status**: Done
- **Scope**: `packages/opencode/test/session/llm-cms-stream.test.ts`

## Summary

Successfully removed skip from google stream coverage by aligning assertions with current cms transport behavior.

## What changed

1. Unskipped google stream test case.
2. Updated test expectation from legacy generative endpoint assumption to current cms transport contract.
3. Hardened local capture server request parsing to avoid JSON parsing failures for non-JSON bodies.

## Validation

- `bun test packages/opencode/test/session/llm-cms-stream.test.ts` → pass
- cms-aligned suite:
  - config / permission / agent / provider-cms / llm-cms-stream
  - **120 pass, 0 fail**
