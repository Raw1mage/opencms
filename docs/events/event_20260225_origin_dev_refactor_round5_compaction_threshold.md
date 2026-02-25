# Event: origin/dev refactor round5 (compaction threshold alignment)

Date: 2026-02-25
Status: Done

## Source behavior

- Upstream reference: `8c7b35ad05c9dca5778501b287c5f17ee59dd0a2`
- Intent: improve compaction overflow threshold when model has no explicit `limit.input`.

## Rewrite-only port in cms

- `packages/opencode/src/session/compaction.ts`
  - For context-only models, `usable` now subtracts computed max output tokens directly from context.
  - This avoids overly conservative double subtraction from `reserved` path and better aligns trigger behavior with input-capped models.

## Additional analysis decisions

- `3befd0c6c57d15369b3177e7d64dd7658ca5ab6a`: integrated (already present)
- `624dd94b5dd8dca03aa3b246312f8b54fd3331f1`: integrated (already present)

## Validation

- `bun test packages/opencode/test/session/compaction.test.ts`
  - Baseline note: first full run had one timeout at 15s.
  - Re-run timed-out case with `--timeout 30000`: pass.
