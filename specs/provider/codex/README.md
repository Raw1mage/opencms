# provider / codex

> Wiki entry. Source of truth = current code under
> `packages/opencode-codex-provider/src/` and
> `packages/opencode/src/provider/codex-compaction.ts`.
> Replaces the legacy spec packages `codex-fingerprint-alignment` and
> the pre-plan-builder `codex/` folder
> (`provider_runtime`, `websocket`, `incremental_delta`, `protocol`,
> `continuation-reset`, `provider-hotfix`).

## Status

shipped (live as of 2026-05-04).

`codex-fingerprint-alignment` is shipped: `buildHeaders` is the single
header entry for both HTTP and WS, `ChatGPT-Account-Id` is TitleCase,
`Accept` / `x-client-request-id` are sent, and `refs/codex` pins to
`rust-v0.125.0-alpha.1`. The pre-plan-builder `codex/` package
(provider_runtime, websocket, incremental_delta, protocol,
continuation-reset, provider-hotfix) describes the
AI-SDK-as-authority + WS-as-transport direction, all merged.

In-flight feature work and known issues live as sub-packages /
issue packages — see **Sub-packages** and **Known issues** below.

## Current behavior

### AI SDK is the authority

The Codex provider is a fetch-interceptor extension layer beneath
the AI SDK Responses adapter, not a parallel CUSTOM_LOADER stack
(the original parallel path is the abandoned direction). Request
body construction flows through AI SDK Responses semantics; codex-
specific augmentation is limited to supported `providerOptions` and
the fetch-interceptor transport / body adjustments. Per-session
state (turnState, conversationId, response_id continuity) is
isolated, never shared via module-global mutable state.

Caching is **disabled** in `ProviderTransform` for the codex native
provider (`transform.ts:397`) because Codex handles caching server-
side via prompt cache continuity and (optionally) inline
`context_management`. See [compaction/](../../compaction/README.md) for the
`/responses/compact` low-cost-server kind.

### Header builder — single entry for HTTP + WS

`buildHeaders(options)` in
`opencode-codex-provider/src/headers.ts` is the single header entry
for both HTTP POST (`provider.ts:222`) and WebSocket upgrade
(`transport-ws.ts:580`, `isWebSocket: true`). Outputs:

- `authorization: Bearer <token>`
- `originator: codex_cli_rs` (constant `ORIGINATOR`)
- `User-Agent: codex_cli_rs/<CODEX_CLI_VERSION> (<OS> <release>; <arch>) terminal`
  — prefix matches `originator` value
- `ChatGPT-Account-Id: <accountId>` — TitleCase
- `x-codex-turn-state: <turnState>` — sticky routing token from
  prior response
- `x-client-request-id: <conversationId>` — upstream codex-rs
  behavior, sent on both HTTP and WS upgrade
- `x-codex-window-id`, `x-codex-parent-thread-id`,
  `x-openai-subagent` — context-window lineage (whitepaper §6,
  upstream codex-rs `9e19004bc2`)
- `session_id`, `User-Agent` — analytics
- HTTP only: `content-type: application/json`,
  `Accept: text/event-stream`
- WS only: `OpenAI-Beta: responses_websockets=2026-02-06`
  (`WS_BETA_HEADER`)

`refs/codex` submodule is pinned to tag `rust-v0.125.0-alpha.1`;
`CODEX_CLI_VERSION` constant in `protocol.ts` reflects
`0.125.0-alpha.1`. Goal is OpenAI's first-party classifier
treating opencode requests as first-party (target third-party
ratio 0%).

### WebSocket transport adapter

`transport-ws.ts` provides a WebSocket transport beneath the
AI-SDK contract, producing a synthetic `Response` with
`text/event-stream` content-type that AI SDK consumes identically
to HTTP SSE. `WrappedWebsocketErrorEvent` frames are parsed and
classified into typed errors (`usage_limit_reached` with status →
rotation-handleable; without status → not mapped, matches codex-rs
test cases; `websocket_connection_limit_reached` → retryable).
Failures fall back to HTTP and the fallback is sticky for the
session's lifetime. Account rotation closes the old WS connection
and opens a new one with the new auth.

### Compaction integration

`packages/opencode/src/provider/codex-compaction.ts` exposes
`codexServerCompact(request)` which POSTs to
`https://chatgpt.com/backend-api/codex/responses/compact`, plus
`buildContextManagement(threshold)` for inline mode. The
no-silent-fallback contract: `codexServerCompact` returns
`{ success: false }` on auth / network / shape errors and the
caller falls through to the documented compaction chain (see
[compaction/](../../compaction/README.md) cost-monotonic chain),
never a pretend-success.

## Code anchors

Codex provider package (`packages/opencode-codex-provider/src/`):

- `protocol.ts` — `ORIGINATOR = "codex_cli_rs"`,
  `CODEX_CLI_VERSION`, `WS_BETA_HEADER`, `buildCodexUserAgent`.
- `headers.ts` — `buildHeaders(options)` single entry.
- `transport-ws.ts` — WS transport adapter; `buildHeaders({
  isWebSocket: true })` call at L580.
- `provider.ts` — HTTP path; `buildHeaders` call at L222.
- `convert.ts` — `case "tool"` exhaustive switch over
  `OcToolResultOutput.kind`.
- `continuation.ts`, `sse.ts`, `auth.ts`, `models.ts` — supporting
  modules.
- `transport-ws.test.ts`, `headers.test.ts`, `provider.test.ts`,
  `convert.test.ts`, `auth.test.ts`, `sse.test.ts` — test surface.

Codex compaction integration:

- `packages/opencode/src/provider/codex-compaction.ts` —
  `codexServerCompact(request)` POSTs to
  `https://chatgpt.com/backend-api/codex/responses/compact`;
  `buildContextManagement(threshold)` for inline mode.

Codex registration in core registry:

- `packages/opencode/src/provider/provider.ts:1343` — codex
  registration, `api.url = https://chatgpt.com/backend-api/codex`
  and `api.npm = @opencode-ai/codex-provider`.
  `CUSTOM_LOADERS["codex"]` returns `{ autoload: true }`; the SDK
  and `getModel` come from the codex AuthHook plugin
  (`codex-auth.ts`).

## Sub-packages

- [codex-update/](./codex-update/) (state: living) — codex feature
  update spec (refs/codex pin bumps + protocol fingerprint refresh
  cycle).
- ~~`ws-snapshot-hotfix/`~~ (archived 2026-05-11 →
  [`specs/archive/ws-snapshot-hotfix-2026-05-11/`](../../archive/ws-snapshot-hotfix-2026-05-11/)) —
  WebSocket snapshot field-mismatch fix landed and stable; one-shot
  scope. The empty-turn recovery gate itself remains in
  [compaction/empty-turn-recovery/](../../compaction/empty-turn-recovery/).

## Cross-cutting empty-response work

The empty-turn / empty-response symptom complex spans codex and
compaction. The sub-packages live where their code does:

- [compaction/empty-turn-recovery/](../../compaction/empty-turn-recovery/)
  (implementing, PAUSED) — empty-turn self-heal compaction gate.
- [compaction/empty-response-rca/](../../compaction/empty-response-rca/)
  (implementing) — RCA for the gpt-5.5 empty-response pattern.
- [compaction/itemcount-fix/](../../compaction/itemcount-fix/)
  (living) — gpt-5.5 itemCount triggers; the symptom site is codex
  but the runloop trigger logic is compaction.

Standing tech debt from MEMORY.md:

- **Stale OAuth (project_codex_stale_oauth)** — Codex accounts
  silently degrade to free plan when OAuth login expires. Fix:
  delete + re-login. Not caused by WS / retry. Provider does not
  auto-detect this state — surfaces as quota exhaustion.
- **Cascade fix delta (project_codex_cascade_fix_and_delta,
  2026-03-30)** — six fixes applied: token-follows-account,
  provider-level guard, UNKNOWN no-promote, WS reset on account
  switch, transport label, rate_limits logging. WS delta still open
  (length-based comparison incompatible with AI SDK's rebuild
  model); codex quota structure observation pending via
  `[WS-RATE-LIMITS]` logs.
- **Account-mismatch (project_account_mismatch_suspect,
  fixed 2026-03-30)** — fetch interceptor now reads
  `x-opencode-account-id` header for rotation-aware auth.
- **Pre-existing codex issues (project_preexisting_codex_issues)**
  — subagent wait, infinite thinking, no response, high tokens —
  all pre-existing, not from refactoring.

## Notes

### incremental_delta status

`incremental_delta` is described in
`specs/_archive/codex/incremental_delta/spec.md` (delta requests
with `previous_response_id`, cache eviction on 4xx/5xx). Phase 3
status of the WS plan; verify in code before relying on it.

### Related entries

- [provider/](../README.md) — cross-provider abstraction (registry,
  family, dispatch, LMv2 envelope).
- [provider/claude/](../claude/README.md) — anthropic / claude-cli
  side.
- [compaction/](../../compaction/README.md) — `/responses/compact`
  low-cost-server kind; codex compaction integration consumer; home
  for `empty-turn-recovery/`, `empty-response-rca/`, `itemcount-fix/`.
- [account/](../../account/README.md) — codex subscription accounts,
  rotation3d, OAuth lifecycle.
