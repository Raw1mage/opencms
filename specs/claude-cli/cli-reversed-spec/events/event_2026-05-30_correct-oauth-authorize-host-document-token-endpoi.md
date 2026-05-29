---
date: 2026-05-30
summary: "Correct OAuth authorize host + document token-endpoint User-Agent throttle in protocol datasheet"
---

# Correct OAuth authorize host + document token-endpoint User-Agent throttle in protocol datasheet

## What changed

Updated `chapters/protocol-datasheets.md` after a production RCA of claude-cli OAuth add-account failures (429 `rate_limit_error`).

### §2.1 OAuth Endpoints — corrected authorize host
- Subscription authorize host was listed as `https://claude.ai/cai/oauth/authorize` — **wrong**. Corrected to `https://claude.com/cai/oauth/authorize` (matches official `CLAUDE_AI_AUTHORIZE_URL` and repo `OAUTH.authorizeClaude`).
- Documented host selection by `loginWithClaudeAi`: subscription → `claude.com/cai`, console → `platform.claude.com`. Redirect URI + token endpoint are shared (`platform.claude.com`) and do not change with authorize host.

### §3.5 User-Agent Variants — new token-endpoint throttle datasheet
- The `claude-code/{VERSION}` UA applies only to the **inference** path (`api.anthropic.com`).
- The **OAuth token endpoint** (`platform.claude.com/v1/oauth/token`, exchange + refresh) is **User-Agent-throttled**: probed 2026-05-30 with an invalid `refresh_token`, `claude-code/{VERSION}` → 429 (throttled before validation), while `axios/*`/`node`/`Bun/*`/arbitrary → 400 (reaches validation). The official CLI's OAuth calls go through plain axios (`axios/{ver}`). Clients MUST NOT send `claude-code/{VERSION}` on the token endpoint — it produces a persistent 429 masquerading as a rate limit.

## Code impact
`packages/provider-claude/src/auth.ts`: authorize host now selected by mode; `OAUTH_USER_AGENT = "axios/1.7.9"` on exchange/refresh/profile. Deployed `webctl restart --force` (versions 202605291606 → 1615 → 1621); verified by adding a second Max account.

## Cross-refs
- `docs/events/claude_oauth_ua_throttle_20260530.md`
- refactor-anthropic skill datasheet §1.4 + §2 (User-Agent endpoint split)
