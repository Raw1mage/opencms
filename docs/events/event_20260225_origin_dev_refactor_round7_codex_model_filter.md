# Event: origin/dev refactor round7 (codex model filter compatibility)

Date: 2026-02-25
Status: Done

## Source behavior

- Upstream reference: `e6e9c15d34f096a472e24603e05f0f6c1cb3dfb7`
- Intent: keep broader codex model variants visible under Codex OAuth flow.

## Rewrite-only port in cms

- `packages/opencode/src/plugin/codex.ts`
  - Expanded `isCodexCompatible` to preserve any model id containing `"codex"`, in addition to existing `gpt-5.*` / `gpt-5-*` families.
  - This prevents accidental filtering of newly named codex-capable models.

## Additional analysis decisions

- `d1ee4c8dca7ec88a608cc640dd11ecb1b0ceb347`: integrated (project test hardening already present)
- `ba54cee55e18b47fb70badc84ae2cbac7c83d258`: integrated (webfetch image attachments already present)

## Validation

- `bun test packages/opencode/test/plugin/codex.test.ts` ✅
