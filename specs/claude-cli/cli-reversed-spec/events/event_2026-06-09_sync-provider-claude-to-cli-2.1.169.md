---
date: 2026-06-09
summary: "Sync provider-claude to claude-code 2.1.169 (VERSION + axios UA bump); document 4 new betas in datasheet"
---

# Sync provider-claude to claude-code 2.1.169

## Trigger

npm `@anthropic-ai/claude-code` advanced to 2.1.169 (the provider was pinned to
2.1.156). Ran `bun packages/provider-claude/scripts/sync-from-cli.ts --version 2.1.169`
against the real native binary (`BUILD_TIME 2026-06-08T03:22:12Z`,
`GIT_SHA eb44edf196b8a320135d5a27a3cfba37773ce0cd`). Two DRIFT fields surfaced.

## What changed (code)

- `protocol.ts`: `VERSION 2.1.156 → 2.1.169`. Feeds the inference-path UA
  (`claude-code/{VERSION}`), the attribution hash, and the `cc_version=` metadata.
- `auth.ts`: `OAUTH_USER_AGENT "axios/1.13.6" → "axios/1.15.2"`. Upstream builds
  the OAuth-endpoint UA as `"axios/"+TvH` where `TvH="1.15.2"` in 2.1.169 (the
  minified var name also drifts — `YPH` in 2.1.156, `TvH` in 2.1.169). Not
  validated server-side; tracked for fingerprint fidelity only.
- `sync-from-cli.ts`: `PINNED_VERSION → 2.1.169`.
- Comment-only version stamps refreshed in `models.ts` and
  `provider/provider.ts` (LMH max-output table re-verified PASS against 2.1.169).

Re-run is `✓ ALIGNED — checked 44 fields`. All 86 provider-claude tests pass.

## What changed (datasheet)

`chapters/protocol-datasheets.md` re-pinned 2.1.144 → 2.1.169:
- Header + §1 VERSION row: new version, build time, SHA.
- §3 OAuth UA throttle: added the concrete bundled axios version (1.15.2) and the
  `"axios/"+{var}` resolution note.
- §4.1 U31 registry: 24 → 28 entries. Added `thinking_token_count`
  (`thinking-token-count-2026-05-13`), `narration_summaries`
  (`summarize-connector-text-2026-03-13`), `server_side_fallback`
  (`server-side-fallback-2026-06-01`), `fallback_credit`
  (`fallback-credit-2026-06-09`).

## Provider stance (unchanged)

The 4 new registry entries are feature-/statsig-gated in the real CLI and are
**NOT** added to `assembleBetas`. The provider still emits only the
normal-subscription-inference subset. The wider registry is catalogued for
fidelity, not as a signal to send those betas.

## Cross-refs

- refactor-anthropic skill §1–3
- Drift tool: `packages/provider-claude/scripts/sync-from-cli.ts`
