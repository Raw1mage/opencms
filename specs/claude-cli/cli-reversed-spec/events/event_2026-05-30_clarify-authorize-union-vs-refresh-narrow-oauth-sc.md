---
date: 2026-05-30
summary: "Clarify authorize(union) vs refresh(narrow) OAuth scope split in datasheet"
---

# Clarify authorize(union) vs refresh(narrow) OAuth scope split in datasheet

## What changed

`chapters/protocol-datasheets.md` §2.2 now documents the three upstream scope vars and which request uses which:

- `$3q` (console) = [org:create_api_key, user:profile]
- `zR$` (claude.ai) = [user:profile, user:inference, user:sessions:claude_code, user:mcp_servers, user:file_upload] → **refresh_token grant**
- `bx8` = union($3q, zR$) = all 6 → **authorize (both login types)**

The authorize request sends the full union for BOTH subscription and console flows (only inferenceOnly narrows to [user:inference]). Refresh uses the narrower zR$ (org:create_api_key there → invalid_scope).

## Why

Closing the last divergence found in the 2026-05-30 OAuth-layer audit: provider-claude was stripping org:create_api_key from the subscription *authorize* scope. That was a workaround for the wrong-authorize-host bug (now fixed), not a real requirement — upstream sends the union for both. Code aligned: authorize() sends AUTHORIZE_SCOPES (union) for both modes; REFRESH_SCOPES stays narrow.

## Code impact
`packages/provider-claude/src/{auth.ts,protocol.ts}`, behavioral checks added to `scripts/sync-from-cli.ts`, regression tests in `test/oauth-auth.test.ts`. Pending user verification via a fresh subscription login.
