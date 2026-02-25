# Event: origin/dev refactor round8 (remove per-message summary title LLM calls)

Date: 2026-02-25
Status: Done

## Source behavior

- Upstream reference: `45fa5e7199b2306395e1d07b9544f2e7dbd1c9a5`
- Intent: stop unnecessary LLM title generation for each summarized message.

## Rewrite-only port in cms

- `packages/opencode/src/session/summary.ts`
  - Removed per-message title-generation block in `summarizeMessage()`.
  - Removed no-longer-needed imports (`Provider`, `LLM`, `Agent`, `Log`) tied to that path.
  - Session/message diff summaries remain unchanged.

## Additional analysis decisions

- `98aeb60a7f0e00e251ff02c360829a3679d65717`: integrated (directory @-references already use Read flow)
- `d018903887861c64ec7ee037e60b24a61501c9c6`: integrated (`run` tool rendering already has malformed payload fallback guards)

## Validation

- `bun run packages/opencode/src/index.ts session list --format json --max-count 1` ✅
- `bun test packages/opencode/test/session/prompt-missing-file.test.ts`
  - first run hit baseline 5s timeout
  - re-run with `--timeout 20000`: pass
