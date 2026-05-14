# provider

> Wiki entry. Source of truth = current code under
> `packages/opencode/src/provider/` and
> `packages/opencode/src/account/`.
> Per-provider package detail lives under
> [provider/claude/](./claude/README.md) (anthropic + claude-cli) and
> [provider/codex/](./codex/README.md) (codex AI-SDK + WS layer).
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
`lmv2-decoupling` Phase 0 (the `OcToolResultOutput` union) was the
entry point for replacing AI-SDK-typed envelopes; later phases (LMv2
stream / prompt / `LanguageModelV2` interface, `streamText`
orchestration) are not yet started — see **Notes**.

Per-provider shipped state — the anthropic `assembleBetas` realign and
the codex `buildHeaders` / `refs/codex` pin / AI-SDK-as-authority
direction — is documented in [provider/claude/](./claude/README.md)
and [provider/codex/](./codex/README.md) respectively.

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

- **codex** — `@opencode-ai/provider-codex` (workspace package
  `packages/provider-codex/`). See
  [provider/codex/](./codex/README.md) for the full HTTP + WS
  fingerprint, AI-SDK-as-authority direction, and compaction
  integration.
- **claude-cli** — `@opencode-ai/provider-claude`
  (`packages/provider-claude/`). See
  [provider/claude/](./claude/README.md) for `assembleBetas`,
  cache-breakpoint placement, and Claude takeover import.
- **gemini-cli** — self-built family added at `provider.ts:1218`,
  inherits from `google-api`/`google` only when missing from
  `database` (event_2026-02-17). Uses the AI-SDK Google adapter but
  has its own model curation.
- **google-api** — uses the AI-SDK Google adapter with a custom
  fetch (`provider.ts:1537`) that injects `thoughtSignature` into
  generativelanguage request bodies.

### LMv2 envelope (Phase 0 only)

`packages/opencode/src/protocol/tool-result.ts` (introduced for
`lmv2-decoupling` Phase 0) defines `OcToolResultOutput` as a
discriminated union (`string` / `text-envelope` /
`content-envelope` / `structured`). `convert.ts` in
`provider-codex` and the OpenAI Responses converters in
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

### Provider-specific known issues / fixes

Per-provider quirks, hotfixes, and pending RCAs live with their
code. Look in the provider sub-folders for codex- and
anthropic-specific work; cross-provider compaction / session
fixes live under their respective topic entries:

- [provider/codex/](./codex/README.md) — codex header / WS / AI-SDK
  authority. Sub-packages: `codex-update/`. (`ws-snapshot-hotfix/`
  archived 2026-05-11 to `specs/archive/ws-snapshot-hotfix-2026-05-11/`
  — fix shipped, one-shot scope complete.)
- [provider/claude/](./claude/README.md) — anthropic betas, cache
  breakpoints, takeover import. Sub-package: `claude-session-list/`.
- [compaction/](../compaction/README.md) — empty-turn-recovery,
  empty-response-rca, itemcount-fix sub-packages (all cross-cut
  with codex but the gate code is in compaction).
- [session/](../session/README.md) — `continuation-fix/` sub-package.

### Provider-management UI tech debt

- **Provider refactor pending** (project_provider_refactor_pending)
  — provider management architecture still needs unified-list
  refactor, `disabled_providers` pollution removal, CRUD
  consistency, delete-button-to-list move. Not blocking the
  dispatch path, but UI / CRUD layer is inconsistent.

### Deprecation surface

- `MINIMUM_BETAS` export from
  `@opencode-ai/provider-claude/protocol` — removed (no shim).
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
  superseded by AI-SDK-as-authority direction (see
  [provider/codex/](./codex/README.md)); future codex extensions
  must extend the AI SDK path or live in the fetch-interceptor
  layer, never as a second authoritative orchestration stack.

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
- Codex `codexServerCompact` returns `{ success: false }` on auth
  / network / shape errors and the caller falls through to the
  documented compaction chain (see [compaction/](../compaction/README.md)
  cost-monotonic chain), not a silent pretend-success.

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

- [provider/claude/](./claude/README.md) — anthropic / claude-cli
  fingerprint, takeover import.
- [provider/codex/](./codex/README.md) — codex header + WS layer +
  compaction integration.
- [account/](../account/README.md) — auth side, account storage,
  rotation3d.
- [session/](../session/README.md) — runloop, identity, capability layer
  (rebind/capability-refresh consumers of provider boundary).
- [compaction/](../compaction/README.md) — codex `/responses/compact`
  low-cost-server kind; fingerprint-aware caching gate; static
  system block + cache breakpoints.
- [attachments/](../attachments/README.md) — attachment subsystem
  consumes the provider transform pipeline.
