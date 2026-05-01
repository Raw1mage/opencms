# Tasks

Phased checklist. Implementing-state agent loads exactly one phase's `- [ ]` items into TodoWrite at a time (plan-builder §16.1).

## 1. Boundary infrastructure (compile-time guard rails)

- [x] 1.1 Create `packages/opencode/src/provider/registry-shape.ts` exporting `RegistryShapeError`, `UnknownFamilyError`, `NoActiveAccountError`, `MigrationRequiredError` per [data-schema.json#Errors](data-schema.json)
- [x] 1.2 Add `assertFamilyKey(providerId, knownFamilies)` helper in registry-shape.ts that throws `RegistryShapeError` on miss
- [x] 1.3 Wire `assertFamilyKey` into the registry write path (every `providers[X] = ...` call site in `provider.ts`); commit with all sites still passing legacy keys — tests will fail loudly until phase 2 lands
- [x] 1.4 Tag `Account.parseProvider` and `Account.resolveFamilyFromKnown` with `@internal:migration-only` JSDoc per DD-9; leave behaviour unchanged

## 2. Registry shape rewrite (DD-1, DD-4)

- [x] 2.1 Extend `Provider.Info` type with `accounts: Record<accountId, AccountState>` sub-map; declare `AccountState` shape per [data-schema.json#ProviderInfo](data-schema.json)
- [x] 2.2 Rewrite the populate loop at [provider.ts:1459-1605](packages/opencode/src/provider/provider.ts#L1459-L1605) — keep one `providers[family]` entry per family; merge per-account options/auth/cooldown into `providers[family].accounts[accountId]` instead of `providers[accountId]`
- [x] 2.3 Rewrite fetch inheritance at [provider.ts:1697-1723](packages/opencode/src/provider/provider.ts#L1697-L1723) to read from `providers[family].accounts[activeAccount].options.fetch`
- [x] 2.4 Audit every `model.providerId = ...` assignment; ensure right-hand side is always a family (never accountId)
- [x] 2.5 Update `mergeProvider(providerId, patch)` and any other internal helpers to assume family-only keys
- [x] 2.6 Run `bun test packages/opencode/test/account/` and `packages/opencode/test/provider/` — expect failures, fix only registry-shape-related ones

## 3. Auth lookup signature change (DD-2)

- [ ] 3.1 Change `Auth.get` signature in [auth/index.ts:82-115](packages/opencode/src/auth/index.ts#L82-L115) to `(family, accountId?)`; remove the `Account.getById(providerId)` exact-match branch (legacy single-arg path)
- [ ] 3.2 Add `UnknownFamilyError` throw when `family` not in `Account.knownFamilies()`
- [ ] 3.3 Add `NoActiveAccountError` throw when `accountId` omitted AND `families[family].activeAccount` empty
- [ ] 3.4 Update auth-loader [provider.ts:1614-1688](packages/opencode/src/provider/provider.ts#L1614-L1688) to pass `(family, accountId)` instead of single string
- [ ] 3.5 Update [agent.ts:381](packages/opencode/src/agent/agent.ts#L381) call site
- [ ] 3.6 Update [mcp/app-registry.ts:360](packages/opencode/src/mcp/app-registry.ts#L360) call site
- [ ] 3.7 Update [custom-loaders-def.ts:35,109,276](packages/opencode/src/provider/custom-loaders-def.ts) call sites
- [ ] 3.8 grep for any remaining `Auth.get(` single-arg call site; fix or fail compile

## 4. getSDK signature change (DD-3)

- [ ] 4.1 Change `getSDK` signature in [provider.ts:2014](packages/opencode/src/provider/provider.ts#L2014) to `(family, accountId, modelId)`
- [ ] 4.2 Replace `s.providers[model.providerId]` lookup with `s.providers[family]`
- [ ] 4.3 Wire auth lookup inside getSDK to `Auth.get(family, accountId)`
- [ ] 4.4 Update both callers at [provider.ts:2421](packages/opencode/src/provider/provider.ts#L2421); pass family+accountId+modelId from caller's `ModelDispatch` context
- [ ] 4.5 Introduce `ModelDispatch { family, accountId, modelId }` type where session processor calls getSDK; carry it through llm.ts dispatch path

## 5. Rotation 3D simplification (DD-5)

- [ ] 5.1 Delete `enforceCodexFamilyOnly` function and its call site in [rotation3d.ts:830-851](packages/opencode/src/account/rotation3d.ts#L830-L851)
- [ ] 5.2 Delete the 2026-05-02 step 3b same-family skip hotfix in [rotation3d.ts:746-775](packages/opencode/src/account/rotation3d.ts#L746-L775); revert step 3b to its pre-hotfix loop body
- [ ] 5.3 Verify `buildFallbackCandidates` only emits candidates with `providerId` ∈ `Account.knownFamilies()`
- [ ] 5.4 Rewrite `test/account/codex-family-only-fallback.test.ts` — assert step 1 (same-family) coverage with family-only providerId pool; remove old string-gate assertions

## 6. Migration script (DD-6, DD-7)

- [ ] 6.1 Create `packages/opencode/scripts/migrate-provider-account-decoupling.ts` with subcommands `--dry-run` (default) and `--apply`
- [ ] 6.2 Implement backup-snapshot: `cp -a accounts.json + storage/session/` to `~/.local/share/opencode/storage/.backup/provider-account-decoupling-<ISO>/` (respect `OPENCODE_DATA_HOME`)
- [ ] 6.3 Implement session-storage walker: traverse `storage/session/**/info.json` and `storage/session/**/messages/**/{info.json,parts/*.json}`; rewrite `providerId`, `execution.providerId`, `model.providerId` fields when `Account.resolveFamilyFromKnown(value)` returns a different family
- [ ] 6.4 Atomic per-file write: write to `<file>.tmp`, fsync, rename
- [ ] 6.5 Idempotent guard: skip write when value already equals resolved family; log `skipped: already-clean`
- [ ] 6.6 Sanity-check `accounts.json`: every `families.<X>` key must be in `knownFamilies()`; throw if not
- [ ] 6.7 Write `.migration-state.json` marker per [data-schema.json#MigrationMarker](data-schema.json) at storage root
- [ ] 6.8 Add `--verify` subcommand: re-run walker in read-only mode, expect zero changes; non-zero exit if anything would change

## 7. Daemon boot guard (DD-6)

- [ ] 7.1 In `packages/opencode/src/index.ts`, before `serve` initialisation, read `.migration-state.json`
- [ ] 7.2 Throw `MigrationRequiredError` if marker missing or `version != "1"`; print remediation hint with the migration script path
- [ ] 7.3 Exit with code 1 (no silent fallback per AGENTS.md rule 1)

## 8. Tests + documentation

- [ ] 8.1 Add `packages/opencode/test/account/provider-account-decoupling.test.ts`: registry rejects per-account key (RegistryShapeError); `Auth.get("codex-subscription-foo")` throws UnknownFamilyError; `Auth.get("codex")` with no active throws NoActiveAccountError; `getSDK("codex", "codex-subscription-foo", "gpt-5.5")` returns bound SDK
- [ ] 8.2 Add `packages/opencode/test/scripts/migrate-decoupling.test.ts`: fixture session with mixed legacy values; dry-run produces deterministic diff matching [test-vectors.json](test-vectors.json); apply + verify is no-op
- [ ] 8.3 Update `specs/architecture.md` with a new `## Provider/Family/Account Naming` section pointing at this spec
- [ ] 8.4 Add an event log entry under `docs/events/event_<YYYYMMDD>_provider-account-decoupling-cutover.md` capturing the cutover timeline + backup path

## 9. Cutover (ops, after merge)

- [ ] 9.1 `opencode daemon stop`
- [ ] 9.2 `bun run packages/opencode/scripts/migrate-provider-account-decoupling.ts --dry-run` — review diff
- [ ] 9.3 `bun run packages/opencode/scripts/migrate-provider-account-decoupling.ts --apply` — backup + sweep + marker
- [ ] 9.4 Smoke check: cat `.migration-state.json`; verify backup tarball exists
- [ ] 9.5 Start new daemon binary; confirm boot succeeds (marker check passes)
- [ ] 9.6 End-to-end smoke: codex completion on `yeats.luo@thesmart.cc`; force a transient error; verify same-family fallback to a different codex account succeeds
