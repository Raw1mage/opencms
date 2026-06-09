# Protocol Datasheets — Claude Code CLI 2.1.169

> Source: native binary `@anthropic-ai/claude-code-linux-x64@2.1.169`
> (`BUILD_TIME 2026-06-08T03:22:12Z`, `GIT_SHA eb44edf196b8a320135d5a27a3cfba37773ce0cd`),
> re-verified 2026-06-09 via `bun packages/provider-claude/scripts/sync-from-cli.ts`.
> Delta-from-2.1.144 notes are retained inline where the registry/constants moved.

---

## §1 Core Constants

| Constant | Value | Notes |
|----------|-------|-------|
| VERSION | `2.1.169` | Build time `2026-06-08T03:22:12Z`, SHA `eb44edf196b8a320135d5a27a3cfba37773ce0cd` |
| API_VERSION | `2023-06-01` | Unchanged since initial release |
| CLIENT_ID | `9d1c250a-e61b-44d9-88ed-5944d1962f5e` | Unchanged |
| ATTRIBUTION_SALT | `59cf53e54c78` | Present but `cch` now hardcoded `00000` |
| BASE_API_URL | `https://api.anthropic.com` | Override: `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_API_BASE_URL` |
| DEFAULT_TIMEOUT | `600000` (10 min) | SDK-level HTTP timeout |

---

## §2 Authentication

### §2.1 OAuth Endpoints

| Endpoint | URL |
|----------|-----|
| Authorize (Console / API key) | `https://platform.claude.com/oauth/authorize` |
| Authorize (Claude.ai / subscription) | `https://claude.com/cai/oauth/authorize` |
| Token | `https://platform.claude.com/v1/oauth/token` |
| Profile | `https://api.anthropic.com/api/oauth/profile` |
| Create API Key | `https://api.anthropic.com/api/oauth/claude_cli/create_api_key` |
| Roles | `https://api.anthropic.com/api/oauth/claude_cli/roles` |
| Redirect URI | `https://platform.claude.com/oauth/code/callback` |
| MCP Proxy | `https://mcp-proxy.anthropic.com/v1/mcp/{server_id}` |
| Client Metadata | `https://claude.ai/oauth/claude-code-client-metadata` |

**Authorize host selection (CRITICAL, corrected 2026-05-30)**: the official CLI
picks the authorize server by the `loginWithClaudeAi` flag — **subscription**
(Pro/Max/Team/Enterprise) → `claude.com/cai/oauth/authorize`; **console**
(API-key) → `platform.claude.com/oauth/authorize`. (Earlier this table listed
the subscription host as `claude.ai/cai`, which is wrong.) The **Redirect URI**
and the **Token** endpoint are shared by both flows (always `platform.claude.com`)
and do **not** change with the authorize host. Sending a subscription login to
the console authorize server yields a console-context code that fails token
exchange — historically misread as a rate limit.

### §2.2 OAuth Scopes

```
org:create_api_key
user:profile
user:inference
user:sessions:claude_code
user:mcp_servers
user:file_upload
```

**Delta from 2.1.126**: `user:mcp_servers` and `user:file_upload` are new. `user:sessions` became `user:sessions:claude_code`.

**Authorize vs refresh scope sets (clarified 2026-05-30)** — three upstream vars:

| Var | Members | Used by |
|-----|---------|---------|
| `$3q` (console) | `org:create_api_key`, `user:profile` | — (component of `bx8`) |
| `zR$` (claude.ai) | `user:profile`, `user:inference`, `user:sessions:claude_code`, `user:mcp_servers`, `user:file_upload` | **refresh_token grant** |
| `bx8` = union(`$3q`,`zR$`) | all 6 above | **authorize** (both login types) |

The authorize request sends the full union `bx8` for **both** subscription and
console flows (only `inferenceOnly` narrows it to `[user:inference]`) — it does
**not** vary scope by login type. The `refresh_token` grant uses the narrower
`zR$` (no `org:create_api_key`; including it there → `invalid_scope`). A
subscription account can't act on `org:create_api_key`; the AS grants the
subset. (Stripping `org:create_api_key` from the subscription *authorize* was a
past workaround for the wrong-host bug, not a real requirement.)

---

## §3 Request Headers

### §3.1 Always-Present Headers

| Header | Value | Notes |
|--------|-------|-------|
| `Authorization` | `Bearer {access_token}` | OAuth/subscription |
| `anthropic-version` | `2023-06-01` | Unchanged |
| `Content-Type` | `application/json` | |
| `User-Agent` | `claude-code/{VERSION}` | Short form (`iO()`) |
| `anthropic-beta` | comma-joined beta flags | See §4 |
| `x-anthropic-billing-header` | See §3.2 | |

### §3.2 Billing Header

Format:
```
cc_version={VERSION}.{model_suffix}; cc_entrypoint={entrypoint}; cch=00000; cc_workload={workload};
```

**Delta from 2.1.126**:
- `cch=00000` is now **hardcoded** (was computed hash `sha256(salt+chars+version).slice(0,3)`)
- `cc_workload=` field is **NEW** (from AsyncLocalStorage context, e.g. `"cron"`)
- `cch` and `cc_workload` are **omitted** for bedrock/anthropicAws/mantle providers

### §3.3 Conditional Headers

| Header | Condition | Value |
|--------|-----------|-------|
| `x-organization-uuid` | `orgID` present | `{orgID}` |
| `anthropic-client-platform` | Always (NEW) | See §3.4 |
| `x-anthropic-additional-protection` | `CLAUDE_CODE_ADDITIONAL_PROTECTION` env | `"true"` |
| `x-claude-code-agent-id` | Subagent | Agent ID |
| `x-claude-code-parent-agent-id` | Subagent | Parent agent ID |
| `x-claude-remote-container-id` | Remote mode | Container ID |
| `x-claude-remote-session-id` | Remote mode | Session ID |
| `x-client-app` | Client app set | App identifier |
| `X-Stainless-Retry-Count` | SDK retry | Retry attempt number |

### §3.4 `anthropic-client-platform` Values (NEW)

| Entrypoint | Header Value |
|------------|-------------|
| `claude-vscode` | `claude_code_vscode` |
| `remote`/`remote_baku`/`remote_desktop`/`remote_mobile` | `claude_code_remote` |
| `sdk-cli`/`sdk-ts`/`sdk-py` | `claude_code_sdk` |
| `mcp` | `claude_code_mcp` |
| `claude-code-github-action` | `claude_code_github_action` |
| `local-agent` | `claude_code_local_agent` |
| `claude_in_slack` | `claude_in_slack` |
| `cli` (default) | `claude_code_cli` |

### §3.5 User-Agent Variants

| Function | Format | Usage |
|----------|--------|-------|
| `iO()` (short) | `claude-code/{VERSION}` | SDK user-agent |
| `Tl()` (full) | `claude-cli/{VERSION} (external, {entrypoint}, ...)` | Extended header |

**Delta from 2.1.126**: Full format prefix changed `claude-code/` → `claude-cli/`.

**OAuth token endpoint is User-Agent-throttled (CRITICAL, added 2026-05-30).**
The User-Agent values above apply to the **inference** path (`api.anthropic.com`).
The OAuth **token endpoint** (`platform.claude.com/v1/oauth/token`, i.e. the
`authorization_code` exchange and `refresh_token` grant) behaves differently:
the official CLI's OAuth calls (`Zn8` / refresh) go through **plain axios**, so
they carry `User-Agent: axios/{ver}` — **not** `claude-code/{VERSION}`. The
bundled axios version is built as `"axios/"+TvH` where `TvH="1.15.2"` in 2.1.169
(was `1.13.6` in 2.1.144; the minified var name also drifts between builds, so
re-resolve `"axios/"+` each sync). The provider mirrors this as
`OAUTH_USER_AGENT = "axios/1.15.2"`. The exact version is not validated
server-side (any non-`claude-code` UA passes); we track it purely for fidelity.

Probed 2026-05-30 (POST with a deliberately invalid `refresh_token`, observing
the status *before* credential validation):

| Request `User-Agent` | Token-endpoint result |
|----------------------|------------------------|
| `axios/*`, `node`, `Bun/*`, arbitrary | **400** (passes throttle → reaches validation) |
| `claude-code/{VERSION}` | **429** `rate_limit_error` (throttled before validation) |

So the token endpoint **buckets by User-Agent** and singles out
`claude-code/{VERSION}` for throttling — almost certainly an anti-impersonation
guard, since the real client never sends that UA here. **Reproductions/clients
MUST send `axios/{ver}` (or any non-`claude-code` UA) on the token endpoint.**
Setting `claude-code/{VERSION}` there produces a persistent 429 that masquerades
as a rate limit. Per-request headers on the exchange/refresh call are otherwise
just `Content-Type: application/json`; the profile call adds
`anthropic-beta: oauth-2025-04-20`.

---

## §4 Beta Flags

### §4.1 Complete Registry (U31 array, 2.1.169)

| # | Internal Name | Beta Header | Status vs 2.1.144 |
|---|---------------|-------------|-------------------|
| 1 | `claude_code` | `claude-code-20250219` | Same |
| 2 | `oauth_auth` | `oauth-2025-04-20` | Same |
| 3 | `interleaved_thinking` | `interleaved-thinking-2025-05-14` | Same |
| 4 | `long_context` | `context-1m-2025-08-07` | Same |
| 5 | `context_management` | `context-management-2025-06-27` | Same |
| 6 | `structured_outputs` | `structured-outputs-2025-12-15` | Same |
| 7 | `web_search` | `web-search-2025-03-05` | Same |
| 8 | `tool_search` (a) | `advanced-tool-use-2025-11-20` | Same |
| 9 | `tool_search` (b) | `tool-search-tool-2025-10-19` | Same |
| 10 | `effort` | `effort-2025-11-24` | Same |
| 11 | `task_budgets` | `task-budgets-2026-03-13` | Same |
| 12 | `prompt_caching_scope` | `prompt-caching-scope-2026-01-05` | Same |
| 13 | `extended_cache_ttl` | `extended-cache-ttl-2025-04-11` | Same |
| 14 | `speed` | `fast-mode-2026-02-01` | Same |
| 15 | `redact_thinking` | `redact-thinking-2026-02-12` | Same |
| 16 | `thinking_token_count` | `thinking-token-count-2026-05-13` | **NEW (2.1.169)** |
| 17 | `narration_summaries` | `summarize-connector-text-2026-03-13` | **NEW in U31** (undocumented in 2.1.144 datasheet) |
| 18 | `afk_mode` | `afk-mode-2026-01-31` | Same |
| 19 | `advisor_tool` | `advisor-tool-2026-03-01` | Same |
| 20 | `cache_diagnosis` | `cache-diagnosis-2026-04-07` | Same |
| 21 | `context_hint` | `context-hint-2026-04-09` | Same |
| 22 | `mcp_servers` | `mcp-servers-2025-12-04` | Same |
| 23 | `files_api` | `files-api-2025-04-14` | Same |
| 24 | `environments` | `environments-2025-11-01` | Same |
| 25 | `ccr_byoc` | `ccr-byoc-2025-07-29` | Same |
| 26 | `mid_conversation_system` | `mid-conversation-system-2026-04-07` | Same |
| 27 | `server_side_fallback` | `server-side-fallback-2026-06-01` | **NEW (2.1.169)** |
| 28 | `fallback_credit` | `fallback-credit-2026-06-09` | **NEW (2.1.169)** |

**Expansion**: 7 flags in 2.1.126 → 24 in 2.1.144 → 28 in 2.1.169.

> **Gating ≠ registry.** Presence in this table is *not* "sent on every request".
> The actual per-request assembly (`WW6`/`QU`/`cH`/`GW6`) and the exact gate for
> each beta are torn down in
> [`betas-and-fallback-teardown-2.1.169.md`](./betas-and-fallback-teardown-2.1.169.md).
> That teardown also flags one live divergence: the CLI emits
> `mid-conversation-system-2026-04-07` on **opus-4-8** (gate `O98`), which
> opencode's `assembleBetas` does not.

> **Provider stance (unchanged by this bump).** `packages/provider-claude` only
> *sends* the subset attached under normal subscription inference: `claude_code`,
> `oauth_auth`, `interleaved_thinking`, `long_context`, `context_management`,
> `prompt_caching_scope`, `extended_cache_ttl`, `speed`, `effort`, `task_budgets`,
> `redact_thinking` (each gated on the matching request condition in
> `assembleBetas`). The rest of the registry — including the 4 new 2.1.169 entries
> (`thinking_token_count`, `narration_summaries`, `server_side_fallback`,
> `fallback_credit`) — are feature-/statsig-gated in the real CLI and are **not**
> emitted by opencode. Cataloguing them is for fingerprint fidelity, **not** a
> signal to add them to the betas array (doing so would send betas the real client
> only sends with those features toggled on).

### §4.2 Additional API-Specific Betas (not in U31)

| Header | Used In |
|--------|---------|
| `compact-2026-01-12` | Server-side compaction endpoint |
| `skills-2025-10-02` | `/v1/skills/` endpoints |
| `ccr-triggers-2026-01-30` | Trigger/schedule endpoints |
| `managed-agents-2026-04-01` | `/v1/environments/` |
| `user-profiles-2026-03-24` | `/v1/user_profiles/` |

---

## §5 Retry & Rate Limit Handling

### §5.1 Two-Layer Architecture

```
┌─────────────────────────────────────┐
│  Layer 2: Claude Code App (CD8)     │
│  Max retries: 10 (CLAUDE_CODE_MAX_  │
│  RETRIES env override)              │
│  Backoff: 500ms base, 32s cap      │
│  ┌───────────────────────────────┐  │
│  │  Layer 1: Anthropic SDK      │  │
│  │  Max retries: 2              │  │
│  │  Backoff: 500ms base, 8s cap │  │
│  └───────────────────────────────┘  │
└─────────────────────────────────────┘
```

Total potential retries: **12** (2 SDK + 10 app) in normal mode, **unlimited** in watchdog mode.

### §5.2 Layer 1 — SDK Retry

**Constants:**
- `maxRetries = 2`
- `timeout = 600000` (10 min)

**`shouldRetry(response)`:**
- 401 with cached OAuth: invalidate cache, retry (once)
- `x-should-retry: "true"` → retry; `"false"` → no
- 408, 409, 429 → retry
- ≥ 500 → retry
- Connection errors (fetch throws) → retry

**Backoff: `calculateDefaultRetryTimeoutMillis`:**
```
attempt = maxRetries - retriesRemaining  // 0, 1, 2
base = min(0.5 * 2^attempt, 8)          // 0.5s, 1s, 2s, 4s, 8s cap
jitter = 1 - random() * 0.25            // 0.75 to 1.0
delay = base * jitter * 1000            // ms
```

**Server-directed:** Reads `retry-after-ms` (ms) or `retry-after` (seconds/HTTP-date) headers.

### §5.3 Layer 2 — App Retry (CD8)

**Constants:**

| Constant | Value | Purpose |
|----------|-------|---------|
| `DEFAULT_MAX_RETRIES` | 10 | Normal mode max attempts |
| `BACKOFF_BASE_MS` | 500 | Exponential base |
| `MAX_RETRY_DELAY_NON_WATCHDOG` | 60000 (60s) | Normal mode max wait; exceeding → throw |
| `MAX_CONSECUTIVE_529_FOR_FALLBACK` | 3 | 529s before fallback model switch |
| `MAX_OAUTH_REFRESH_ATTEMPTS` | 2 | Auth retry cap |
| `MAX_OAUTH_SAME_TOKEN_RETRIES` | 2 | Same-token retry cap |
| `CCR_AUTH_RETRY_DELAY` | 1000 (1s) | Remote auth retry delay |
| `PERSISTENT_RETRY_MAX_BACKOFF` | 300000 (5 min) | Watchdog mode max backoff |
| `ABSOLUTE_MAX_DELAY` | 21600000 (6 hours) | Absolute cap for persistent mode |
| `YIELD_INTERVAL` | 30000 (30s) | UI update chunk during long waits |
| `FAST_MODE_FALLBACK_WINDOW` | 1800000 (30 min) | Fast mode fallback window |
| `FAST_MODE_SHORT_RETRY_THRESHOLD` | 20000 (20s) | Fast mode short retry threshold |
| `FAST_MODE_MIN_FALLBACK_WINDOW` | 600000 (10 min) | Fast mode min fallback window |

**App-level backoff function `rt(attempt, retryAfterHeader, maxBackoff=32000)`:**
```
base = min(500 * 2^(attempt-1), maxBackoff)  // 500ms, 1s, 2s, 4s, ... 32s cap
jitter = base + random() * 0.25 * base       // adds 0-25% on top
if retryAfterHeader: delay = max(serverDelay, jitter)
return delay
```

### §5.4 Retry Decision Flow

```
On error from SDK:
  1. Abort signal? → throw AbortError
  2. Auth error (401/403)? → rebuild client, refresh OAuth token
     - Max 2 same-token retries before giving up
  3. Fast mode + (429|529)?
     - Check overage-disabled-reason header → disable fast mode, retry immediately
     - retry-after < 20s? → sleep and retry (no counter decrement)
     - Else: disable fast mode, schedule re-enable after max(retry-after, 10min)
  4. 529 on background query? → drop (no retry)
  5. 3 consecutive 529s + fallback model? → switch to fallback model
  6. Watchdog mode (CLAUDE_CODE_RETRY_WATCHDOG)?
     - Uses separate counter with 5min backoff cap
     - Sleeps in 30s chunks (yields UI progress messages)
     - NEVER gives up (resets counter after persistent delay)
  7. attempt > maxRetries (not watchdog)? → throw fatal
  8. Context overflow (400 "input + max_tokens > context")?
     - Parse error, reduce max_tokens, retry immediately (no delay)
  9. Retryable? (d35 check):
     - YES: overloaded_error, context overflow, 401, 407, 408, 409, 429, ≥500,
            connection errors, x-should-retry="true"
     - NO: everything else
  10. Compute delay:
      - Persistent: read anthropic-ratelimit-unified-reset header, or backoff(5min cap), clamp to 6h
      - CCR auth: fixed 1s
      - Normal: rt(attempt, retryAfter), if > 60s → throw (refuses to wait)
  11. Sleep delay, yield UI message ("Rate limited - retrying in Xs")
  12. Loop back to retry
```

### §5.5 Unified Rate Limit Headers (read on every response)

| Header | Purpose |
|--------|---------|
| `anthropic-ratelimit-unified-status` | `allowed` / `allowed_warning` / `rejected` |
| `anthropic-ratelimit-unified-reset` | Epoch seconds when quota resets |
| `anthropic-ratelimit-unified-fallback` | `"available"` when fallback exists |
| `anthropic-ratelimit-unified-representative-claim` | Claim ID |
| `anthropic-ratelimit-unified-overage-status` | Overage state |
| `anthropic-ratelimit-unified-overage-reset` | Overage reset time |
| `anthropic-ratelimit-unified-overage-disabled-reason` | Why overage disabled |
| `anthropic-ratelimit-unified-upgrade-paths` | Available upgrade paths |
| `*-surpassed-threshold` | Warning threshold hit |
| Per-window: `5h`, `7d`, `overage` | Utilization + reset per window |

---

## §6 Request Body

### §6.1 Standard Fields

```json
{
  "model": "claude-opus-4-6",
  "messages": [...],
  "system": [...],
  "tools": [...],
  "tool_choice": "auto",
  "max_tokens": 32000,
  "thinking": {"type": "enabled", "budget_tokens": N},
  "temperature": 1.0,
  "stream": true,
  "metadata": {...},
  "betas": [...],
  "context_management": {...},
  "speed": "fast",
  "output_config": {...}
}
```

### §6.2 max_tokens Defaults

| Model | Default | Upper Limit |
|-------|---------|-------------|
| claude-3-haiku | 4096 | 4096 |
| claude-3-5-sonnet/haiku | 8192 | 8192 |
| claude-3-7-sonnet | 32000 | 64000 |
| All others (opus etc.) | 32000 | 128000 |

Override: `CLAUDE_CODE_MAX_OUTPUT_TOKENS` env var.

### §6.3 Model ID Normalization

`[1m]`/`[2m]` suffix is stripped before sending to API via `GL()`:
```js
model.replace(/\[(1|2)m\]/gi, "")
```

---

## §7 SSE Transport

### §7.1 SSE Event Types

| Event | Description |
|-------|-------------|
| `message_start` | Initial message with model info + usage |
| `content_block_start` | New content block (text / tool_use / thinking) |
| `content_block_delta` | Incremental text / input_json delta |
| `content_block_stop` | Content block complete |
| `message_delta` | End-of-message metadata (stop_reason, usage) |
| `message_stop` | Final event |
| `ping` | Keep-alive |
| `error` | Server error event |
| `compaction_delta` | Server-side compaction content (NEW) |
| `signature_delta` | Response signature (NEW) |

### §7.2 SSE Parser

Standard `event:`/`data:` line protocol. Accumulates `data:` lines, emits on blank line. Lines starting with `:` are comments (ignored).

### §7.3 Stream Error Handling

- Stream does **NOT** auto-reconnect on failure
- Errors propagate up to the app retry loop (§5)
- `APIConnectionTimeoutError` causes graceful stream end (no retry)

---

## §8 Tool System

### §8.1 MCP Tool Prefix

Format: `mcp__{serverName}__{toolName}`

```js
function createToolName(server, tool) {
  return `mcp__${sanitize(server)}__${sanitize(tool)}`
}
```

Parser splits on `__`, expects `["mcp", serverName, ...toolNameParts]`.

### §8.2 Built-in Tool Names

- `mcp__workspace__bash` — Shell execution
- `mcp__workspace__web_fetch` — Web fetch

---

## §9 Cache Control

### §9.1 Cache Breakpoints

```json
{"type": "ephemeral", "ttl": "1h", "scope": "global"}
```

- TTL `"1h"` enabled when `auto_mode` is active (AFK/background)
- Otherwise `undefined` (default 5-minute cache)
- `scope: "global"` when cross-session caching desired

### §9.2 Placement

- System prompt blocks: `cache_control` on each text block
- Last content block in conversation: sliding breakpoint
- Tool schemas: per-tool `cacheControl` field

---

## §10 Context Management & Compaction

### §10.1 Auto-Compact

- Enabled by default (`autoCompactEnabled: true`)
- Window: configurable 100K–1M tokens (`autoCompactWindow`)
- Server-side compaction via `edits: [{type: "compact_20260112"}]`
- SDK-level compaction deprecated

### §10.2 Compact Boundary

System messages with `subtype: "compact_boundary"` mark compaction points.

---

## §11 Model Routing

### §11.1 Provider Routes

| Provider | Example model ID |
|----------|-----------------|
| `firstParty` | `claude-opus-4-6` |
| `bedrock` | `us.anthropic.claude-opus-4-6-v1` |
| `vertex` | `claude-opus-4-6` |
| `foundry` | `claude-opus-4-6` |
| `anthropicAws` | `claude-opus-4-6` |
| `mantle` | `anthropic.claude-opus-4-7` (opus-4-6 is null) |
| `gateway` | `claude-opus-4-6` |

### §11.2 Model Family (2.1.144)

```
haiku35, haiku45,
sonnet35, sonnet37, sonnet40, sonnet45, sonnet46,
opus40, opus41, opus45, opus46, opus47
```

### §11.3 `?beta=true` Endpoints

All beta API calls append `?beta=true`:
- `/v1/messages?beta=true`
- `/v1/messages/batches?beta=true`
- `/v1/messages/count_tokens?beta=true`
- `/v1/files?beta=true`
- `/v1/models?beta=true`
- `/v1/environments?beta=true`
- `/v1/agents?beta=true`
- `/v1/user_profiles?beta=true`

---

## §12 Delta from 2.1.126

### Major Changes

1. **16 new beta flags** (7 → 24 active slots)
2. **`anthropic-client-platform` header** — entirely new
3. **`cc_workload` billing field** — new AsyncLocalStorage-driven field
4. **`cch=00000`** — attribution hash now static
5. **`x-anthropic-additional-protection` header** — new
6. **User-Agent prefix** — `claude-code/` → `claude-cli/` in extended form
7. **OAuth scopes** — added `user:mcp_servers`, `user:file_upload`
8. **New API surfaces** — `/v1/skills/`, `/v1/files/`, triggers, CCR BYOC
9. **SSE events** — `compaction_delta`, `signature_delta` added
10. **Model registry** — `opus47` added, mantle support for opus-4-7

### Unchanged

- `anthropic-version`: `2023-06-01`
- Client ID: `9d1c250a-e61b-44d9-88ed-5944d1962f5e`
- OAuth endpoints
- Core retry architecture (2-layer, same constants)
- SSE parser logic
- Tool prefix format (`mcp__`)
