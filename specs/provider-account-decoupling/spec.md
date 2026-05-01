# Spec: provider-account-decoupling

## Purpose

Restore `(provider, account, model)` as three independent dimensions in the runtime by removing per-account providerIds from the provider registry, auth lookup, and getSDK paths. Account identity stays opaque; provider identity is always a family.

## Glossary

- **family** — canonical provider name registered in `Account.knownFamilies`, e.g. `"codex"`, `"openai"`, `"anthropic"`, `"gemini-cli"`. Always a valid `providerId`.
- **accountId** — opaque per-account identifier persisted under `families.<family>.accounts.<accountId>` in `accounts.json`. Today it happens to take the shape `<family>-(subscription|api)-<slug>`; that shape is not changed by this spec, but it MUST NOT be used as a `providerId` anywhere outside `accounts.json` storage.
- **per-account providerId (legacy)** — the bug being fixed: any code path that uses `accountId` as if it were a `providerId` (registry key, auth lookup arg, model.providerId field, SDK lookup).

## Requirements

### Requirement: Registry holds only families

- **GIVEN** the provider registry `providers: { [providerId]: Info }` declared in [provider.ts:1030](packages/opencode/src/provider/provider.ts#L1030)
- **WHEN** the registry is populated (currently at [provider.ts:1459-1605](packages/opencode/src/provider/provider.ts#L1459-L1605))
- **THEN** every key in `providers` MUST be a registered family (matches `Account.knownFamilies()`)
- **AND** populating the registry with a per-account providerId MUST throw `RegistryShapeError` immediately (no silent fallback per AGENTS.md rule 1)

#### Scenario: codex with 16 subscription accounts

- **GIVEN** `accounts.json.families.codex.accounts` has 16 entries
- **WHEN** the registry is built
- **THEN** `providers["codex"]` exists exactly once, holding the family-level `Provider.Info` (template models, env, fetch)
- **AND** no key matching `^codex-subscription-` exists in `providers`

### Requirement: Auth lookup is two-arg

- **GIVEN** any caller that needs auth credentials
- **WHEN** it calls `Auth.get(...)`
- **THEN** the new signature `Auth.get(family: string, accountId?: string)` MUST be used
- **AND** `family` MUST be a registered family; otherwise throw `UnknownFamilyError`
- **AND** if `accountId` is omitted, the active account for that family is used (`Account.getActive(family)`)
- **AND** the legacy single-arg form is removed (no shim, no overload)

#### Scenario: explicit account requested

- **GIVEN** a session pinned to `accountId="codex-subscription-business-thesmart-cc"` for family `"codex"`
- **WHEN** caller invokes `Auth.get("codex", "codex-subscription-business-thesmart-cc")`
- **THEN** the auth blob for that account is returned
- **AND** the active account selection is NOT consulted

#### Scenario: family without an active account

- **GIVEN** family `"codex"` has accounts but no `activeAccount` set
- **WHEN** caller invokes `Auth.get("codex")` with no accountId
- **THEN** throws `NoActiveAccountError` with the family name
- **AND** does NOT silently pick the first account

### Requirement: getSDK takes (family, account)

- **GIVEN** any model dispatch
- **WHEN** caller invokes `getSDK(family, accountId, modelId)` (new signature)
- **THEN** returns the SDK client bound to that account's auth
- **AND** `family` MUST be in the registry; `accountId` MUST be present in `accounts.json.families.<family>.accounts`
- **AND** the legacy `getSDK(model)` form that read `model.providerId` is removed

### Requirement: Model carries family providerId

- **GIVEN** any `Model` object emitted from the registry, persisted, or sent over the bus
- **WHEN** its `providerId` field is read
- **THEN** the value MUST be a family
- **AND** code paths that previously set `model.providerId = accountId` (e.g. [provider.ts:1593](packages/opencode/src/provider/provider.ts#L1593)) MUST be rewritten to set `model.providerId = family` and carry account identity as a separate field on the dispatching context (not on `Model`)

### Requirement: rotation3d uses canonical comparisons

- **GIVEN** the rotation candidate pool building flow
- **WHEN** `enforceCodexFamilyOnly` (or any equivalent gate) compares family
- **THEN** the comparison MUST be `candidate.providerId === current.providerId` (both are families by construction)
- **AND** the previous string-based exception in [rotation3d.ts:830-851](packages/opencode/src/account/rotation3d.ts#L830-L851) MUST be deleted (not retained as a defensive shim)
- **AND** the step 3b same-family skip introduced as a hotfix on 2026-05-02 MUST also be removed (it becomes redundant once registry holds only families)

### Requirement: One-shot storage migration

- **GIVEN** an existing installation with session messages, accounts.json, and rate-limit tracker state
- **WHEN** the migration script `scripts/migrate-provider-account-decoupling.ts` is executed (daemon stopped)
- **THEN** every persisted `providerId` field across `~/.local/share/opencode/storage/session/**/messages/**` is normalised to family form
- **AND** `accounts.json` is left structurally unchanged (it is already family-keyed) but a sanity-check pass verifies every `families.<X>` key is in `Account.knownFamilies`
- **AND** rate-limit tracker state (in-memory) is not migrated; it is rebuilt on daemon restart
- **AND** before any write, a snapshot is taken to `~/.local/share/opencode/storage/.backup/provider-account-decoupling-<timestamp>/`
- **AND** the script is idempotent — running it twice produces no further change after the first successful run

#### Scenario: legacy session message with per-account providerId

- **GIVEN** a stored message with `providerId: "codex-subscription-foo", accountId: "codex-subscription-foo"`
- **WHEN** migration runs
- **THEN** the message becomes `providerId: "codex", accountId: "codex-subscription-foo"`

#### Scenario: already-clean session message

- **GIVEN** a stored message with `providerId: "codex", accountId: "codex-subscription-foo"`
- **WHEN** migration runs
- **THEN** the message is left unchanged
- **AND** the migration log records `skipped: already-clean`

### Requirement: Cutover atomicity

- **GIVEN** a deployment of the new code
- **WHEN** the daemon is restarted with the new binary
- **THEN** the migration MUST have completed first (verified by checking a marker `.migration-state.json` written by the script)
- **AND** if the marker is missing or older than the current binary version, daemon startup MUST fail loudly with `MigrationRequiredError`
- **AND** the daemon MUST NOT attempt to run the migration itself (separation of concerns: ops decision, not runtime)

## Acceptance Checks

- `bun test packages/opencode/test/account/` passes; `codex-family-only-fallback.test.ts` rewritten to assert step 1 coverage instead of string-based gate
- New test `provider-account-decoupling.test.ts` covers: registry shape rejection, two-arg `Auth.get`, `getSDK(family, account, model)`, model.providerId is always family
- Migration script dry-run on a backed-up storage produces a deterministic diff (recorded in `test-vectors.json`)
- After migration + daemon restart, a fresh codex completion succeeds end-to-end on `yeats.luo@thesmart.cc` AND on a same-family fallback (`business@thesmart.cc`)
- `grep -rn "subscription-\|api-" packages/opencode/src/ | grep -v test/` returns only the construction site in `Account.generateId` and the storage key references — no runtime dispatch sites
- `enforceCodexFamilyOnly` is deleted; `rotation3d.ts` step 3b same-family hotfix is deleted; both removals reflected in the diff
