# Claude CLI Protocol Datasheet

> Source of truth: `@anthropic-ai/claude-code@2.1.112` npm package (`cli.js`)
> Mirrored at: `refs/claude-code-npm/cli.js`
> Extraction date (last bump): 2026-05-03
> Previous reference versions: 2.1.92, 2.1.39
>
> **Note:** 2.1.113+ shipped as native binary (no JS source). 2.1.112 is the
> last upstream release where protocol constants are inspectable as source.
> See `refs/claude-code-npm/REFS.md` for cutover details.
>
> **Beta-flag assembly logic** is captured in detail at
> `specs/claude-provider-beta-fingerprint-realign/design.md` § Research
> Outcomes (DD-11 through DD-15). Section 11 below is the current truth.

---

## 1. Global Constants

| Constant | Value | Notes |
|---|---|---|
| VERSION | `"2.1.126"` (User-Agent) / `"2.1.112"` (datasheet ref) | UA bumped 2026-05-03; datasheet pinned to last JS release |
| CLIENT_ID (production) | `"9d1c250a-e61b-44d9-88ed-5944d1962f5e"` | OAuth client identifier |
| CLIENT_ID (local-oauth) | `"22422756-60c9-4084-8eb7-27705fd5cf9a"` | For local development only |
| ATTRIBUTION_SALT | `"59cf53e54c78"` | Used in billing header hash (`jBY` in minified) |
| TOOL_PREFIX | `"mcp__"` | **Double underscore**; format: `mcp__{serverName}__{toolName}` |
| BASE_API_URL | `"https://api.anthropic.com"` | Production API base |
| anthropic-version | `"2023-06-01"` | API version header, unchanged |

---

## 2. Attribution / Billing Header

### Header Name
`x-anthropic-billing-header`

### Format
```
cc_version={VERSION}.{HASH}; cc_entrypoint={ENTRYPOINT};[ cch=00000;][ cc_workload={WORKLOAD};]
```

### Hash Algorithm (`KA7` in minified, was `T8A` in 2.1.39)

```javascript
function calculateAttributionHash(content: string, version: string): string {
  const SALT = "59cf53e54c78"
  const indices = [4, 7, 20]
  const chars = indices.map(idx => content[idx] || "0").join("")
  const input = `${SALT}${chars}${version}`
  return sha256(input).digest("hex").slice(0, 3)
}
```

- **Unchanged** from 2.1.39 — same salt, same indices, same truncation.

### Content Source for Hash Input

| Version | Source |
|---|---|
| 2.1.39 (ours) | Last message in `parsed.messages` |
| 2.1.92 (official) | **First non-meta user message's text content** (`HBY` function) |

### Conditional Fields

| Field | Condition |
|---|---|
| `cch=00000;` | Included for direct API / subscription auth. **Omitted** for bedrock/anthropicAws |
| `cc_workload={WORKLOAD};` | Optional. Set by subprocess spawner for workload tracking |
| `cc_entrypoint` | Read from `CLAUDE_CODE_ENTRYPOINT` env, default `"unknown"` |

---

## 3. OAuth

### Endpoints

| Purpose | URL |
|---|---|
| Authorize (Console) | `https://platform.claude.com/oauth/authorize` |
| Authorize (Claude.ai) | `https://claude.com/cai/oauth/authorize` |
| Token Exchange | `https://platform.claude.com/v1/oauth/token` |
| Profile | `https://api.anthropic.com/api/oauth/profile` |
| API Key Creation | `https://api.anthropic.com/api/oauth/claude_cli/create_api_key` |
| Roles | `https://api.anthropic.com/api/oauth/claude_cli/roles` |
| Redirect URI | `https://platform.claude.com/oauth/code/callback` |

### Scopes

| Context | Scopes |
|---|---|
| Authorize (full) | `org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload` |
| Refresh Token | `user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload` |
| Console-only subset | `org:create_api_key user:profile` |

> **Delta from 2.1.39**: `user:file_upload` scope is new.

### PKCE Parameters

- Challenge method: `S256` (SHA-256)
- Verifier: random string (via `generatePKCE()`)
- State parameter: set to verifier value

### Token Exchange Request Body

```json
{
  "code": "{authorization_code}",
  "state": "{state_from_code_fragment}",
  "grant_type": "authorization_code",
  "client_id": "{CLIENT_ID}",
  "redirect_uri": "https://platform.claude.com/oauth/code/callback",
  "code_verifier": "{verifier}"
}
```

### Token Refresh Request Body

```json
{
  "grant_type": "refresh_token",
  "refresh_token": "{refresh_token}",
  "client_id": "{CLIENT_ID}",
  "scope": "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload"
}
```

---

## 4. Request Headers

### Required Headers (all requests)

| Header | Value |
|---|---|
| `Authorization` | `Bearer {access_token}` |
| `anthropic-version` | `2023-06-01` |
| `Content-Type` | `application/json` |
| `User-Agent` | `claude-code/{VERSION}` |
| `anthropic-beta` | Dynamic per-request (see Beta Flags section) |

### Conditional Headers

| Header | Condition | Value |
|---|---|---|
| `x-organization-uuid` | If orgID available | `{orgID}` |
| `x-anthropic-billing-header` | All messages requests | See Attribution section |

### Header Scrub

Our implementation scrubs SDK-injected headers that could interfere with Claude Code identity:

| Header | Reason |
|---|---|
| `x-api-key` | Conflicts with Bearer auth |
| `anthropic-client` | SDK identity conflicts |
| `x-app` | SDK app tag conflicts |
| `session_id` | Triggers non-Claude-Code detection |
| `x-opencode-tools-debug` | OpenCode internal |
| `x-opencode-account-id` | OpenCode internal |

> Note: 2.1.92 builds headers from scratch rather than scrubbing. Our scrub approach is an adaptation for the plugin architecture.

---

## 5. URL Rewrite

| Endpoint | Rewrite |
|---|---|
| `/v1/messages` | Append `?beta=true` |
| `/v1/models` | Append `?beta=true` (2.1.92 does this; we don't call this endpoint) |
| `/v1/files/*` | Uses `files-api-2025-04-14` beta header |

---

## 6. System Prompt Identity

### Three Variants

| Variant | String | Condition |
|---|---|---|
| Interactive (default) | `"You are Claude Code, Anthropic's official CLI for Claude."` | Standard CLI mode |
| Agent SDK (appended) | `"You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK."` | When running inside Agent SDK |
| Pure Agent | `"You are a Claude agent, built on Anthropic's Claude Agent SDK."` | Standalone agent mode |

### Injection Rules

1. If `system` is array: filter empty text blocks, then prepend identity as first text block if not already present
2. If `system` is string: prepend identity if not present
3. If no `system`: set to identity string
4. All three variants are accepted by the validation set (`fG8 = new Set(hD_)`)

---

## 7. Tool Name Prefix (mcp_)

### Request Transform (outgoing)

| Version | Prefix | Format |
|---|---|---|
| 2.1.39 (ours) | `mcp_` (single underscore) | `mcp_{toolName}` |
| 2.1.92 (official) | `mcp__` (double underscore) | `mcp__{sanitizedServerName}__{sanitizedToolName}` |

Prefixing applies to:
- `tools[].name` in request body
- `tool_use` content blocks in `messages[].content`

### Response Transform (incoming)

Strip `mcp_` / `mcp__` prefix from `"name"` fields in SSE streaming response.

Our regex: `/"name"\s*:\s*"mcp_([^"]+)"/g` → `"name": "$1"`

> **Note**: Our single-underscore prefix has been working. The double-underscore format in 2.1.92 encodes the MCP server name, which we don't use (our tools are direct, not proxied through MCP servers).

---

## 8. SSE Streaming Response

### Event Types (Anthropic Messages API)

| Event | Data Structure |
|---|---|
| `message_start` | `{ type: "message_start", message: { id, type, role, content: [], model, usage } }` |
| `content_block_start` | `{ type: "content_block_start", index, content_block: { type: "text"|"tool_use"|"thinking" } }` |
| `content_block_delta` | `{ type: "content_block_delta", index, delta: { type: "text_delta"|"input_json_delta"|"thinking_delta" } }` |
| `content_block_stop` | `{ type: "content_block_stop", index }` |
| `message_delta` | `{ type: "message_delta", delta: { stop_reason }, usage: { output_tokens } }` |
| `message_stop` | `{ type: "message_stop" }` |
| `ping` | `{ type: "ping" }` |
| `error` | `{ type: "error", error: { type, message } }` |

### Usage Extraction

- `message_start` → `message.usage` (input tokens, cache tokens)
- `message_delta` → `usage` (output tokens)

---

## 9. Model Catalog (2.1.92)

### Max Output Token Overrides (`zz8` in minified)

| Model ID | Max Output |
|---|---|
| `claude-opus-4-20250514` | 8192 |
| `claude-opus-4-0` | 8192 |
| `claude-4-opus-20250514` | 8192 |
| `claude-opus-4-1-20250805` | 8192 |

> New in 2.1.92: `claude-opus-4-1-20250805` and its Bedrock/Vertex variants.

### Context Windows

All current models: 200k tokens (context-1m beta enables 1M for supported models).

---

## 10. New Endpoints in 2.1.92

| Endpoint | Purpose |
|---|---|
| `/v1/files` | File upload/download (Files API) |
| `/v1/skills` | Skills marketplace API |
| `/api/oauth/claude_cli/roles` | Role checking for auth |
| `https://mcp-proxy.anthropic.com/v1/mcp/{server_id}` | MCP server proxy |

---

## 11. Beta Flag Assembly (cli.js@2.1.112 ZR1)

> Decoded from `refs/claude-code-npm/cli.js` function `ZR1` at offset ~3482150;
> beta-string constants block at offset ~2439173. Helper predicates `ja`, `iO_`,
> `I7`, `$Q` resolved at offsets 3481451, 3480483, 38983, 2317694 respectively.
>
> Source-of-truth in opencode: `packages/opencode-claude-provider/src/protocol.ts`
> function `assembleBetas`. Test matrix: `specs/claude-provider-beta-fingerprint-realign/test-vectors.json`.

### 11.1 Helper predicates

| Helper | Upstream symbol | Definition |
|---|---|---|
| `isHaikuModel(modelId)` | `o5(q).includes("haiku")` | lowercased substring match |
| `supports1MContext(modelId)` | `DP(q)` | prefix in `{claude-opus-4, claude-opus-4-7, claude-sonnet-4-5, claude-sonnet-4-6}` |
| `supportsThinking(modelId)` | `ggq(q)` | true unless `DISABLE_INTERLEAVED_THINKING` env set |
| `isFirstPartyish(provider)` | `$Q(q)` | `provider ∈ {firstParty, anthropicAws, foundry, mantle}` |
| `modelSupportsContextManagement(modelId, provider)` | `iO_(q)` | foundry → true ; firstPartyish → !startsWith("claude-3-") ; else → contains opus-4/sonnet-4/haiku-4 |
| `ja()`-equivalent | `ja()` | `isFirstPartyish(provider) && !disableExperimentalBetas` |
| `isInteractive` | `!I7()` | `B8.isInteractive` truthy. **opencode runtime always false (DD-17)** |

### 11.2 Push order (canonical sequence)

Each push is an independent gate. The output array preserves this exact order so the comma-joined header value matches upstream byte-for-byte under equivalent inputs.

| # | Flag | Gate |
|---|---|---|
| 1 | `claude-code-20250219` | `!isHaiku` |
| 2 | `oauth-2025-04-20` | `isOAuth` |
| 3 | `context-1m-2025-08-07` | `supports1MContext(modelId)` |
| 4 | `interleaved-thinking-2025-05-14` | `supportsThinking(modelId) && !disableInterleavedThinking` |
| 5 | `redact-thinking-2026-02-12` | `ja() && supportsThinking(m) && !disableInterleavedThinking && isInteractive && !showThinkingSummaries` |
| 6 | `context-management-2025-06-27` | `provider === "firstParty" && !disableExperimentalBetas && modelSupportsContextManagement(m, provider)` |
| 7 | `structured-outputs-2025-12-15` | RESERVED — tengu_tool_pear flag, not in opencode path |
| 8 | `web-search-2025-03-05` | RESERVED — vertex/foundry only, not in opencode path |
| 9 | `prompt-caching-scope-2026-01-05` | `ja()` (NOT `isOAuth` — see DD-11) |
| 10 | `...env.ANTHROPIC_BETAS` | append, then dedup preserving first-occurrence |

### 11.3 opencode-specific posture

| Field | opencode runtime value | Reason |
|---|---|---|
| `isOAuth` | always `true` | DD-16: OAuth-only auth posture; provider.ts panics on non-OAuth creds |
| `provider` | always `"firstParty"` | DD-4: opencode does not route through Bedrock/Vertex/Foundry |
| `isInteractive` | always `false` | DD-17: opencode is a daemon serving SSE, not a TTY |

Effect: `redact-thinking-2026-02-12` never fires from opencode runtime; the matrix tests still cover it for upstream-fidelity assertions.

### 11.4 Divergences fixed by this realign

Pre-realign (commit 4f6039bf1 and earlier): `assembleBetas` collapsed three flags into a `MINIMUM_BETAS` always-send set, mis-gated `prompt-caching-scope` on `isOAuth` instead of `ja()`, omitted `redact-thinking` entirely, and produced flags in a non-upstream order. Six divergences are enumerated in
`specs/claude-provider-beta-fingerprint-realign/proposal.md` § Why; full DECISIONS in `design.md` DD-1 through DD-17.

---

## Appendix: Wire Format Example

### Request (subscription auth, messages endpoint)

```
POST /v1/messages?beta=true HTTP/1.1
Host: api.anthropic.com
Authorization: Bearer {access_token}
anthropic-version: 2023-06-01
anthropic-beta: claude-code-20250219,oauth-2025-04-20,context-1m-2025-08-07,interleaved-thinking-2025-05-14,context-management-2025-06-27,prompt-caching-scope-2026-01-05
User-Agent: claude-code/2.1.126
Content-Type: application/json
x-organization-uuid: {orgUuid}
x-anthropic-billing-header: cc_version=2.1.126.a3f; cc_entrypoint=unknown; cch=00000;

{
  "model": "claude-sonnet-4-6-20250627",
  "max_tokens": 16384,
  "stream": true,
  "system": [
    { "type": "text", "text": "You are Claude Code, Anthropic's official CLI for Claude.\n\n..." }
  ],
  "messages": [...],
  "tools": [
    { "name": "mcp__opencode__read_file", "description": "...", "input_schema": {...} }
  ]
}
```
