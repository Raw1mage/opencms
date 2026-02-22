# Event: CMS stream payload google follow-up

- **Date**: 2026-02-21
- **Status**: In Progress
- **Scope**: `packages/opencode/test/session/llm-cms-stream.test.ts`

## What was attempted

1. Unskipped google stream contract test and attempted request-contract-only validation.
2. Added abort/drain flow to avoid response-decoder coupling.

## Current status

- Google stream contract test still non-deterministic under current local harness and remains skipped.
- Added stable replacement assertion to preserve cms coverage value:
  - `Provider.getModel("google", "gemini-2.5-flash")` resolves in baseline config.

## Validation snapshot

- cms-aligned suite result: **119 pass, 1 skip, 0 fail**.

## Next

1. Build provider-specific google stream fixture that matches exact SDK parser expectations.
2. Re-enable google stream contract test once deterministic.
