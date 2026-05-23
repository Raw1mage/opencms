# provider / copilot-cli

> Wiki entry. Source of truth = current code under
> `packages/opencode/src/plugin/copilot-cli/` (9 modules).
> Reversed-from: `@github/copilot@1.0.48` CLI binary.
> Implementation plan: `plans/github-copilot_provider-implementation/`
> (DD-1 ~ DD-13).

## Status

shipped (live as of 2026-05-18).

Self-contained GitHub Copilot provider that reproduces CLI-binary
auth and API behavior without AI SDK runtime dependency (DD-9).
Uses own OAuth device flow (DD-1: `Ov23li8tweQw6odWQebz`, scope
`read:user`), own token exchange, own HTTP client + SSE parser,
own circuit breaker (DD-3), and own LanguageModelV2 adapter.

## Current behavior

### Self-built data path (DD-8, DD-9, DD-12)

copilot-cli is a **plugin** (`packages/opencode/src/plugin/copilot-cli/`),
not a provider-package like codex or claude-cli. It registers via
the Plugin hook system (`auth.provider`, `auth.loader`, `auth.methods`,
`chat.headers`). The adapter (`adapter.ts`) implements
`LanguageModelV2` by importing only **types** from `@ai-sdk/provider` —
no AI SDK runtime code in the data path.

This validates the DD-12 direction: self-built data path is feasible,
and codex + claude-cli should eventually migrate similarly.

### OAuth device flow → token exchange → auto-refresh

`auth.ts` handles the full lifecycle:

1. **Device flow** — POST `/login/device/code` with OpenCMS client ID
   `Ov23li8tweQw6odWQebz` (scope: `read:user` only; CLI uses wider
   `read:user,read:org,repo,gist`). Returns `device_code` +
   `user_code` for browser auth, polls `/login/oauth/access_token`
   until user completes (RFC 8628).
2. **Token exchange** — POST `/copilot_internal/v2/token` with Bearer
   `gho_...` to get short-lived `capiSessionToken` (typically 30min).
   **DD-2 fallback**: if exchange fails, falls back to raw
   `access_token` with warning log.
3. **Auto-refresh** — `getBearer()` checks expiry before every API
   call. If < 60s remaining, re-runs `initAuth()` which also
   refreshes profile (DD-4: token + profile refresh are coupled).

### Dual-path API routing (Chat Completions vs Responses API)

`models.ts:shouldUseResponsesApi(modelId)` determines the API path:

- **Priority 1**: profile feature flag `copilot_cli_websocket_responses`
- **Priority 2**: heuristic — GPT-5+ (excluding gpt-5-mini) →
  Responses API
- Everything else → Chat Completions

The two paths have fundamentally different message formats:

| Aspect | Chat Completions | Responses API |
|--------|-----------------|---------------|
| Endpoint | `/chat/completions` | `/responses` |
| Container | `messages[]` | `input[]` |
| Tool calls | nested in `assistant.tool_calls[]` | **top-level** `{ type: "function_call" }` |
| Tool results | `{ role: "tool", tool_call_id }` | **top-level** `{ type: "function_call_output" }` |
| Tools schema | `{ type: "function", function: { name } }` | `{ type: "function", name }` (flat) |

`adapter.ts` provides format converters:
- `promptToMessages()` / `promptToResponsesInput()` — prompt conversion
- `toolsToCompletions()` / `toolsToResponses()` — tool schema conversion
- Both SSE parsers emit unified `LanguageModelV2StreamPart` events

### Tool call round-trip

The complete cycle in `adapter.ts:doStream()`:

1. SSE stream delivers tool call (Completions: `delta.tool_calls[i]`;
   Responses: `response.output_item.added`)
2. Arguments accumulate from deltas → assembled on stream end
3. `tool-call` event emitted; **finish reason forced to `"tool-calls"`**
   even if API says `"stop"` — AI SDK won't execute tools otherwise
4. OpenCMS runloop executes tool → result back
5. `stringifyOutput()` normalizes result (string/array/object/undefined)
6. Result serialized as `role: "tool"` or `function_call_output` for
   next API turn

### Circuit breaker (DD-3)

`circuit-breaker.ts` — independent utility, reusable by other providers.

Three states: **CLOSED** (normal) → **OPEN** (failing, block all) →
**HALF_OPEN** (probe one request).

- Trigger: 5 consecutive `[500, 502, 503, 504]` responses
- Reset timeout: 30s (exponential backoff up to 120s on repeated
  HALF_OPEN failures)
- Probe: HALF_OPEN allows exactly one request; success → CLOSED,
  failure → OPEN with doubled timeout
- Singleton shared across all copilot-cli requests

### Request header injection

`index.ts` loader's custom fetch interceptor adds:

| Header | Value | When |
|--------|-------|------|
| `Authorization` | `Bearer ${capiSessionToken}` | always |
| `x-initiator` | `"user"` / `"agent"` | always (agent if subagent or non-user last msg) |
| `Openai-Intent` | `conversation-edits` | always |
| `Copilot-Vision-Request` | `true` | image parts detected |
| `User-Agent` | `opencode/${version}` | always |

Removes conflicting `x-api-key` and lowercase `authorization` from
AI SDK defaults.

### rawToolSchemas side-channel (bun compile workaround)

**Problem**: In `bun compile` binaries, `Symbol.for("ai.schema.*")`
loses identity across module boundaries → AI SDK's `isSchema()`
fails → tool schemas resolve to empty → tools completely broken.

**Solution**: `resolve-tools.ts` pre-populates `rawToolSchemas`
Map<toolName, jsonSchema> at startup. `adapter.ts:getToolSchemaWithFallback()`
tries (in order):
1. `t.parameters?.jsonSchema` (AI SDK getter — works in dev mode)
2. `t.parameters` as raw object
3. `rawToolSchemas.get(t.name)` (final fallback — works in compiled binary)

### Quota

`quota.ts:getCopilotQuota()` — GET `/copilot_internal/v2/token` or
`/account/quota`, returns per-type snapshots (chat, completions,
premium_interactions) with entitlement, usage, reset date.
Exposed via provider layer `getQuota()` hook (DD-6).

### Enterprise support

| Aspect | GitHub.com | GitHub Enterprise |
|--------|-----------|------------------|
| OAuth | `github.com/login/device/code` | `<domain>/login/device/code` |
| API | `api.github.com` | `<domain>/api/v3` |
| Copilot API | `api.githubcopilot.com` | profile `endpoints.api` |

Domain normalization: strips `https://` and trailing `/`.

## Code anchors

Plugin modules (`packages/opencode/src/plugin/copilot-cli/`):

- `index.ts` — plugin entry, auth hooks, fetch interceptor, device flow trigger
- `auth.ts` — OAuth device flow, token exchange, bearer management, auto-refresh
- `profile.ts` — `/copilot_internal/user` fetch, feature flags extraction
- `models.ts` — `shouldUseResponsesApi()`, `isGpt5OrLater()` routing logic
- `client.ts` — HTTP client, SSE parser (`parseSSE()`), `guardedFetch()` with circuit breaker
- `circuit-breaker.ts` — 3-state machine, exponential backoff, singleton
- `adapter.ts` — `LanguageModelV2` bridge, prompt/tool format conversion, dual-path streaming
- `quota.ts` — quota fetch + parse
- `types.ts` — shared interfaces (`CopilotUser`, `CopilotTokenState`, `CircuitBreakerConfig`)

Framework registration sites:

- `packages/opencode/src/plugin/index.ts` — `getInternalPlugins()` includes copilot-cli
- `packages/opencode/src/provider/supported-provider-registry.ts` — `"copilot-cli"` entry
- `packages/opencode/src/provider/provider.ts` — bundled models in `initState()`
- `packages/app/src/components/model-selector-state.ts` — `KNOWN_PROVIDER_FAMILIES` + label map

## Design decisions

| DD | Decision | Rationale |
|----|----------|-----------|
| DD-1 | Own client ID `Ov23li8tweQw6odWQebz`, scope `read:user` only | CLI's wider scope requires re-auth; security impact unassessed |
| DD-2 | Token exchange fallback to raw `access_token` | Graceful degradation; logged as warning |
| DD-3 | Circuit breaker as independent utility class | Reusable across providers |
| DD-4 | Profile refreshes with token | Minimizes API calls |
| DD-5 | Profile/Token/Quota as module-private state | Self-contained plugin |
| DD-6 | Quota via provider `getQuota()` hook | Unified frontend path |
| DD-7 | "Reproduction" not "gap-fill" | Complete behavior replication from reversed spec |
| DD-8 | Plugin is self-contained, no cross-provider dependency | Plugin boundary = auth + API; framework handles rest |
| DD-9 | Minimal AI SDK dependency; types-only import | Enables bun compile; validates self-built data path |
| DD-10 | Family name `copilot-cli` | Matches `codex`, `claude-cli` naming |
| DD-11 | Format converters copied from AI SDK, not imported | No runtime SDK in data path |
| DD-12 | Validates self-built data path feasibility | codex + claude-cli should migrate similarly |
| DD-13 | Write new-provider SOP from this experience | [provider/new-provider-sop/](../new-provider-sop/README.md) |

## Reversed-spec chapters

Detailed wire-level datasheets and IDEF0/GRAFCET models live in
[github-copilot/cli-reversed-spec/](../../github-copilot/cli-reversed-spec/README.md):

- `protocol-datasheets.md` — §1-§12 covering OAuth, token exchange,
  auto-refresh, feature flags, circuit breaker, header injection,
  Chat Completions / Responses API formats, dual-path routing,
  tool call round-trip, bun compile workaround, quota
- `idef0.07.json` / `grafcet.07.json` — Tool call round-trip
- `idef0.08.json` / `grafcet.08.json` — Dual-path API routing
- `idef0.09.json` / `grafcet.09.json` — Circuit breaker

(Chapters 01-06 cover the upstream CLI binary behavior; 07-09 cover
the OpenCMS implementation.)

## Related entries

- [provider/](../README.md) — cross-provider abstraction (registry,
  family, dispatch, LMv2 envelope).
- [provider/codex/](../codex/README.md) — codex provider (AI SDK
  authority direction; copilot-cli validates the opposite: self-built).
- [provider/claude/](../claude/README.md) — anthropic / claude-cli.
- [github-copilot/cli-reversed-spec/](../../github-copilot/cli-reversed-spec/README.md) —
  reversed spec of upstream CLI binary.
- [github-copilot/sdk-reversed-spec/](../../github-copilot/sdk-reversed-spec/README.md) —
  reversed spec of upstream SDK.
- [account/](../../account/README.md) — account storage, rotation3d.
