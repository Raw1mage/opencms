# provider

> Wiki entry. Source of truth = current code under
> `packages/opencode/src/provider/`,
> `packages/opencode/src/account/`,
> `packages/opencode-claude-provider/src/`, and
> `packages/opencode-codex-provider/src/`.
> Replaces the legacy spec packages
> `provider-account-decoupling`, `lmv2-decoupling`,
> `claude-provider-beta-fingerprint-realign`,
> `codex-fingerprint-alignment`, and the pre-plan-builder `codex/` folder.

## Status

shipped (live as of 2026-05-04).

`provider-account-decoupling` is in production: the registry holds only
families, `Auth.get` is two-arg, `getSDK(family, accountId, model)` is
the only dispatch entry, the `enforceCodexFamilyOnly` and step-3b
hotfix are deleted, and `MigrationRequiredError` gates daemon boot.
`claude-provider-beta-fingerprint-realign` is shipped: `assembleBetas`
in `@opencode-ai/claude-provider` mirrors upstream `ZR1` push order and
`MINIMUM_BETAS` is removed. `codex-fingerprint-alignment` is shipped:
`buildHeaders` is the single header entry for both HTTP and WS,
`ChatGPT-Account-Id` is TitleCase, `Accept`/`x-client-request-id` are
sent, and `refs/codex` pins to `rust-v0.125.0-alpha.1`. The pre-
plan-builder `codex/` package (`provider_runtime`, `websocket`,
`incremental_delta`, `protocol`, `continuation-reset`,
`provider-hotfix`) describes the AI-SDK-as-authority + WS-as-transport
direction, all merged. `lmv2-decoupling` Phase 0 (the `OcToolResultOutput`
union) was the entry point for replacing AI-SDK-typed envelopes;
later phases (LMv2 stream / prompt / `LanguageModelV2` interface,
`streamText` orchestration) are not yet started — see **Notes**.

## Current behavior

### Three independent dimensions: (family, account, model)

`(provider, account, model)` are independent in the runtime.
**Family** is the canonical provider name (`codex`, `openai`,
`anthropic`, `gemini-cli`, `claude-cli`, `google-api`, `bedrock`, …)
and is always a valid `providerId`. **AccountId** is opaque, persisted
under `accounts.json.families.<family>.accounts.<accountId>`, and may
take the surface shape `<family>-(subscription|api)-<slug>` for
display, but it MUST NOT be used as `providerId` outside storage.
**Model** carries `model.providerId === family`; account identity is
carried separately on the dispatching context, never on `Model`.

### Registry holds only families (assertFamilyKey)

`Provider.providers: { [providerId]: Info }` is built in
`provider.ts` (`mergeProvider` at L1092). Every write goes through
`assertFamilyKey(providerId, knownFamilies)` from
`provider/registry-shape.ts`, throwing `RegistryShapeError` on miss
— no silent fallback. The known set is the union of
`Account.knownFamilies({ includeStorage: true })` ∪
`Object.keys(database)`; the database key path covers curated /
inherited entries (e.g. `github-copilot-enterprise`) that aren't in
models.dev. Per-account slugs (`codex-subscription-<x>`) never enter
`database` and are rejected at insertion.

`Account.knownFamilies()` (`account/index.ts:272`) unions the
`PROVIDERS` whitelist, models.dev, `accounts.json.families.*`, and a
synthetic-families bag (`canonical-family-source.ts`) for
inheritance-only entries. Managed-app provider keys are stripped
from `accounts.json` on load (event_20260326).

### Auth.get is two-arg (family, accountId?)

`Auth.get(family: string, accountId?: string)` (`auth/index.ts:94`)
is the only auth lookup signature. `family` MUST be a registered
family or `UnknownFamilyError` is thrown. With `accountId` omitted,
the active account for that family is consulted via
`Account.getActive(family)`; if the family has accounts but no
active selection, `NoActiveAccountError` is thrown — no silent
first-account pick. The legacy single-arg form is removed (no shim).

### getSDK takes (family, accountId, model)

`getSDK(family, accountId, model)` (`provider.ts:2115`) is the only
dispatch path. `family` MUST be in the registry; `accountId` MUST be
present in `accounts.json.families.<family>.accounts`. The cache key
is per-(family, accountId) so 16 codex subscription accounts share
one `providers["codex"]` entry but get 16 distinct SDK clients.

### Boot guard: MigrationRequiredError

`server/migration-boot-guard.ts` reads
`<Global.Path.data>/storage/.migration-state.json` at startup and
refuses to start (`MigrationRequiredError` → `serve.ts` exits with
code 1) if the marker is missing, unparseable, or its `version` !=
`"1"`. Operator must run
`bun run packages/opencode/scripts/migrate-provider-account-decoupling.ts --apply`
first. Per AGENTS.md rule 1, the daemon never auto-runs the
migration — that is an ops decision.

### rotation3d uses canonical comparisons

`enforceCodexFamilyOnly` is deleted. Family comparison in
`account/rotation3d.ts` is canonical: `candidate.providerId ===
current.providerId` (both are families by construction). The
2026-05-02 step-3b same-family hotfix is removed because the
registry shape guarantee makes it redundant.

### Bundled providers and SDK plug-in points

`provider.ts` directly imports the AI-SDK adapters
(`createAnthropic`, `createOpenAI`, `createOpenAICompatible`,
`createGoogleGenerativeAI`, `createVertex`, `createVertexAnthropic`,
`createAmazonBedrock`, `createAzure`, `createXai`, `createMistral`,
`createGroq`, `createDeepInfra`, `createCerebras`, `createCohere`,
`createGateway`, `createTogetherAI`, `createPerplexity`,
`createVercel`, `createOpenRouter`, `createGitLab`, plus the local
`createGitHubCopilotOpenAICompatible` from `provider/sdk/copilot`).
Each AI-SDK adapter is keyed by npm name in the `getSDK` switch and
selected via `model.api.npm`.

Self-built / non-AI-SDK paths:

- **codex** — `@opencode-ai/codex-provider` (workspace package
  `packages/opencode-codex-provider/`). Registered in `database` at
  `provider.ts:1343` with `api.url =
  https://chatgpt.com/backend-api/codex` and `api.npm =
  @opencode-ai/codex-provider`. `CUSTOM_LOADERS["codex"]` returns
  `{ autoload: true }`; the SDK and `getModel` come from the codex
  AuthHook plugin (`codex-auth.ts`).
- **claude-cli** — `@opencode-ai/claude-provider`
  (`packages/opencode-claude-provider/`). Same pattern via
  `CUSTOM_LOADERS["claude-cli"]` and the anthropic auth plugin.
- **gemini-cli** — self-built family added at `provider.ts:1218`,
  inherits from `google-api`/`google` only when missing from
  `database` (event_2026-02-17). Uses the AI-SDK Google adapter but
  has its own model curation.
- **google-api** — uses the AI-SDK Google adapter with a custom
  fetch (`provider.ts:1537`) that injects `thoughtSignature` into
  generativelanguage request bodies.

### Codex provider — AI SDK is the authority

The Codex provider is a fetch-interceptor extension layer beneath
the AI SDK Responses adapter, not a parallel CUSTOM_LOADER stack
(the original parallel path is the abandoned direction). Request
body construction flows through AI SDK Responses semantics; codex-
specific augmentation is limited to supported `providerOptions` and
the fetch-interceptor transport/body adjustments. Per-session
state (turnState, conversationId, response_id continuity) is
isolated, never shared via module-global mutable state.

Caching is **disabled** in `ProviderTransform` for the codex native
provider (`transform.ts:397`) because Codex handles caching server-
side via prompt cache continuity and (optionally) inline
`context_management`. See [compaction.md](../compaction/README.md) for the
`/responses/compact` low-cost-server kind.

### Codex header builder — single entry for HTTP + WS

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

### Codex WebSocket transport adapter

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

### Anthropic — assembleBetas mirrors upstream ZR1

`assembleBetas(options)` in
`opencode-claude-provider/src/protocol.ts:232` produces the
`anthropic-beta` header values byte-equivalently to upstream
`claude-code@2.1.112` `ZR1`. Push order:

1. `claude-code-20250219` — if `!isHaiku`
2. `oauth-2025-04-20` — if `isOAuth`
3. `context-1m-2025-08-07` — if `supports1M(model)`
4. `interleaved-thinking-2025-05-14` — if
   `supportsThinking(model) && !disableInterleavedThinking`
5. `redact-thinking-2026-02-12` — if `isFirstPartyish(provider) &&
   !disableExperimentalBetas && supportsThinking(model) &&
   !disableInterleavedThinking && isInteractive &&
   !showThinkingSummaries`. Opencode runtime always passes
   `isInteractive=false` (DD-17), so this is suppressed in the
   daemon path.
6. `context-management-2025-06-27` — if `provider==="firstParty"
   && !disableExperimentalBetas &&
   modelSupportsContextManagement(model, provider)`
7. RESERVED slot: `structured-outputs-2025-12-15` (upstream `t76`,
   not emitted)
8. RESERVED slot: `web-search-2025-03-05` (upstream `Qv1`, vertex/
   foundry only, not emitted)
9. `prompt-caching-scope-2026-01-05` — if
   `isFirstPartyish(provider) && !disableExperimentalBetas` (NOT
   gated on `isOAuth`, DD-11)
10. env-supplied `ANTHROPIC_BETAS` appended, then deduped

`MINIMUM_BETAS` constant is removed (members repositioned as
conditional pushes). `isFirstPartyish(p)` =
`p ∈ {firstParty, anthropicAws, foundry, mantle}`.
`modelSupportsContextManagement(m, p)`: foundry → true;
firstPartyish → `!m.startsWith("claude-3-")`; else → matches
opus-4 / sonnet-4 / haiku-4.

### Anthropic cache breakpoint placement

`ProviderTransform.applyCaching` (`provider/transform.ts:252`)
places ephemeral cache breakpoints. Phase B explicit breakpoints
(BP2 = T1 end, BP3 = T2 end) are walked from
`providerOptions.phaseB.breakpoint=true` markers placed by the
context preface emitter; legacy BP1 (system tail) and BP4
(conversation tail) are placed by tail-position rule. Caching is
disabled for subscription sessions and for native providers
(`@opencode-ai/claude-provider`, `@opencode-ai/codex-provider`)
because those providers manage their own cache.

### LMv2 envelope (Phase 0 only)

`packages/opencode/src/protocol/tool-result.ts` (introduced for
`lmv2-decoupling` Phase 0) defines `OcToolResultOutput` as a
discriminated union (`string` / `text-envelope` /
`content-envelope` / `structured`). `convert.ts` in
`opencode-codex-provider` and the OpenAI Responses converters in
`provider/sdk/copilot/responses/` switch exhaustively on `kind`.
The 2026-04-24 hardening throw added in `c26d7e0bf` is retained
as defense-in-depth even though the exhaustive switch makes it
unreachable. `fromLmv2(raw)` throws on unconvertible shapes — no
silent `unknown` bottoming out, per AGENTS.md rule 1.

## Code anchors

Core registry + dispatch:

- `packages/opencode/src/provider/provider.ts` — `Provider`
  namespace (2896 lines). `mergeProvider` at L1092,
  `assertFamilyKey` invocation at L1096, `getSDK(family,
  accountId, model)` at L2115. `providers[]` insertion sites
  L1459–L1605 (codex registration L1343).
- `packages/opencode/src/provider/registry-shape.ts` — full file
  is the boundary contract. `RegistryShapeError`,
  `UnknownFamilyError`, `NoActiveAccountError`,
  `MigrationRequiredError`, `assertFamilyKey`.
- `packages/opencode/src/account/index.ts` — `Account` namespace.
  `knownFamilies` L272, `getActive` L757, `Storage.families`
  schema L114.
- `packages/opencode/src/account/rotation3d.ts` — same-family
  candidate pool (post-`enforceCodexFamilyOnly` deletion).
  Comment block L262, family-comparison gate L820+.
- `packages/opencode/src/account/canonical-family-source.ts` —
  synthetic / inherited families bag (DD-1 follow-up
  2026-05-03).
- `packages/opencode/src/auth/index.ts` — `Auth.get(family,
  accountId?)` at L94.
- `packages/opencode/src/server/migration-boot-guard.ts` —
  `assertMigrationApplied()` boot gate.
- `packages/opencode/src/cli/cmd/serve.ts` — boot guard caller
  (catches `MigrationRequiredError` at L43, exits with code 1).
- `packages/opencode/scripts/migrate-provider-account-decoupling.ts`
  — one-shot storage migration.

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

Anthropic provider package (`packages/opencode-claude-provider/src/`):

- `protocol.ts` — `assembleBetas` at L232; per-flag constants
  L77–L86; `isFirstPartyish` L115; model predicates L124–L168.
- `headers.ts`, `convert.ts`, `provider.ts`, `auth.ts`, `sse.ts`,
  `models.ts` — supporting modules.

Transform / cache:

- `packages/opencode/src/provider/transform.ts` —
  `ProviderTransform` namespace. `applyCaching` L252; subscription
  / native-provider opt-out L397.
- `packages/opencode/src/provider/transform.applyCaching.test.ts`
  — BP1–BP4 placement coverage.

Custom loaders:

- `packages/opencode/src/provider/custom-loaders-def.ts` — codex
  + claude-cli registration (autoload only); openai responses
  routing.

LMv2 envelope:

- `packages/opencode/src/protocol/tool-result.ts` —
  `OcToolResultOutput` union + `fromLmv2`.

## Notes

### Open / partial work

- **lmv2-decoupling phases 1-4** — Phase 0 (envelope) is shipped.
  Phase 1 (LMv2 stream part), Phase 2 (LMv2 prompt / message),
  Phase 3 (`LanguageModelV2` interface), Phase 4 (`streamText` /
  `generateText` orchestration replacement) are not started.
  Each subsequent phase moves a piece of `@ai-sdk/*` dependency
  off the AI SDK and onto opencode's own protocol types.
  See `specs/_archive/lmv2-decoupling/handover-phase-0.md` for context.
- **Per-tool R-1 self-bounding** — universal coverage of every
  variable-size tool (per the original `tool-output-chunking`
  spec) requires audit.
- **`incremental_delta`** — described in
  `specs/_archive/codex/incremental_delta/spec.md` (delta requests with
  `previous_response_id`, cache eviction on 4xx/5xx). Phase 3
  status of the WS plan; verify in code.

### Known issues from MEMORY.md

- **Codex stale OAuth (project_codex_stale_oauth)** — Codex
  accounts silently degrade to free plan when OAuth login expires.
  Fix: delete + re-login. Not caused by WS / retry. Provider does
  not auto-detect this state — it surfaces as quota exhaustion.
- **Codex cascade fix (project_codex_cascade_fix_and_delta,
  2026-03-30)** — six fixes applied: token-follows-account,
  provider-level guard, UNKNOWN no-promote, WS reset on account
  switch, transport label, rate_limits logging. WS delta is open
  (length-based comparison incompatible with AI SDK's rebuild
  model); codex quota structure observation pending via
  `[WS-RATE-LIMITS]` logs.
- **Account-mismatch suspect (project_account_mismatch_suspect,
  fixed 2026-03-30)** — fetch interceptor now reads
  `x-opencode-account-id` header for rotation-aware auth.
- **Provider refactor pending
  (project_provider_refactor_pending)** — provider management
  architecture still needs unified-list refactor, `disabled_providers`
  pollution removal, CRUD consistency, delete-button-to-list move.
  Not blocking the dispatch path, but UI/CRUD layer is
  inconsistent.
- **Pre-existing codex issues (project_preexisting_codex_issues)**
  — subagent wait, infinite thinking, no response, high tokens —
  all pre-existing, not from refactoring.

### Deprecation surface

- `MINIMUM_BETAS` export from
  `@opencode-ai/claude-provider/protocol` — removed (no shim).
  Importers fail at TypeScript compile time.
- `enforceCodexFamilyOnly` and the 2026-05-02 step-3b same-family
  hotfix in `rotation3d.ts` — deleted (no shim).
- Legacy `Auth.get(providerId)` single-arg form — removed (no
  shim).
- Legacy `getSDK(model)` form that read `model.providerId` —
  removed.
- Per-account providerId encoding (`codex-subscription-<slug>` as
  `providerId`) — rejected at registry boundary by
  `assertFamilyKey`.
- Original parallel `CUSTOM_LOADER` codex authority path —
  superseded by AI-SDK-as-authority direction
  (`specs/_archive/codex/provider_runtime/spec.md`); future codex
  extensions must extend the AI SDK path or live in the fetch-
  interceptor layer, never as a second authoritative orchestration
  stack.

### No-silent-fallback compliance (AGENTS.md rule 1)

Provider-load failures error loudly:

- `assertFamilyKey` throws `RegistryShapeError` synchronously at
  every `providers[X] = ...` write site.
- `Auth.get(family, ...)` throws `UnknownFamilyError` for
  non-registered family; `NoActiveAccountError` when accountId is
  omitted but no active account is set (no first-account silent
  pick).
- `assertMigrationApplied` throws `MigrationRequiredError` and
  `serve.ts` exits with code 1 on missing / outdated marker —
  daemon never auto-runs migration.
- `OcToolResultOutput.fromLmv2(raw)` throws on unconvertible
  shapes — no `kind: "unknown"` bottoming out.
- `codexServerCompact` returns `{ success: false }` on auth /
  network / shape errors and the caller falls through to the
  documented compaction chain (`compaction.md` cost-monotonic
  chain), not a silent pretend-success.

### Storage migration

`scripts/migrate-provider-account-decoupling.ts` (run once,
daemon stopped) normalises every persisted `providerId` field
under `~/.local/share/opencode/storage/session/**/messages/**`
to family form. `accounts.json` is left structurally unchanged
(already family-keyed; migration sanity-checks every
`families.<X>` key against `Account.knownFamilies`). Rate-limit
tracker state is not migrated — rebuilt on daemon restart.
A snapshot is taken to
`~/.local/share/opencode/storage/.backup/provider-account-decoupling-<timestamp>/`
before any write. Idempotent: second run is no-op.
Marker written to
`<Global.Path.data>/storage/.migration-state.json` with
`version: "1"`.

### Related entries

- [account.md](../account/README.md) — auth side, account storage,
  rotation3d.
- [session.md](../session/README.md) — runloop, identity, capability layer
  (rebind/capability-refresh consumers of provider boundary).
- [compaction.md](../compaction/README.md) — codex `/responses/compact`
  low-cost-server kind; fingerprint-aware caching gate; static
  system block + cache breakpoints.
- [attachments.md](../attachments/README.md) — attachment subsystem
  consumes the provider transform pipeline.
