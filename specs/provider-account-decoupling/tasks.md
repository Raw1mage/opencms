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

- [x] 3.1 Change `Auth.get` signature in [auth/index.ts:82-115](packages/opencode/src/auth/index.ts#L82-L115) to `(family, accountId?)`; remove the `Account.getById(providerId)` exact-match branch (legacy single-arg path)
- [x] 3.2 Add `UnknownFamilyError` throw when `family` not in `Account.knownFamilies()`
- [x] 3.3 Add `NoActiveAccountError` throw when `accountId` omitted AND `families[family].activeAccount` empty
- [x] 3.4 Update auth-loader [provider.ts:1614-1688](packages/opencode/src/provider/provider.ts#L1614-L1688) to pass `(family, accountId)` instead of single string
- [x] 3.5 Update [agent.ts:381](packages/opencode/src/agent/agent.ts#L381) call site
- [x] 3.6 Update [mcp/app-registry.ts:360](packages/opencode/src/mcp/app-registry.ts#L360) call site
- [x] 3.7 Update [custom-loaders-def.ts:35,109,276](packages/opencode/src/provider/custom-loaders-def.ts) call sites
- [x] 3.8 grep for any remaining `Auth.get(` single-arg call site; fix or fail compile

## 4. getSDK signature change (DD-3)

- [x] 4.1 Change `getSDK` signature in [provider.ts:2014](packages/opencode/src/provider/provider.ts#L2014) to `(family, accountId, modelId)`
- [x] 4.2 Replace `s.providers[model.providerId]` lookup with `s.providers[family]`
- [x] 4.3 Wire auth lookup inside getSDK to `Auth.get(family, accountId)`
- [x] 4.4 Update both callers at [provider.ts:2421](packages/opencode/src/provider/provider.ts#L2421); pass family+accountId+modelId from caller's `ModelDispatch` context
- [x] 4.5 Introduce `ModelDispatch { family, accountId, modelId }` type where session processor calls getSDK; carry it through llm.ts dispatch path

## 5. Rotation 3D simplification (DD-5)

- [x] 5.1 Deleted `enforceCodexFamilyOnly` function and its call site in `rotation3d.ts`
- [x] 5.2 Deleted the 2026-05-02 step 3b same-family skip hotfix; per-step counter telemetry from `c27a127e8` retained
- [x] 5.3 `buildFallbackCandidates` only emits family-form `providerId` — enforced structurally by `assertFamilyKey` on the registry write path (Phase 1.3), no runtime check needed
- [x] 5.4 `test/account/codex-family-only-fallback.test.ts` rewritten as a contract test documenting the post-DD-1 invariant

## 6. Migration script (DD-6, DD-7)

- [x] 6.1 `packages/opencode/scripts/migrate-provider-account-decoupling.ts` with `--dry-run` (default) / `--apply` / `--verify`
- [x] 6.2 Backup-snapshot to `<storage>/.backup/provider-account-decoupling-<ISO>/` (respects `OPENCODE_DATA_HOME`); covers `accounts.json` + `storage/{session,message}`
- [x] 6.3 Walker uses the *real* on-disk layout — `storage/message/<sid>/<mid>.json` (top-level `providerId` + nested `model.providerId`) and `storage/session/<sid>/info.json` (`execution.providerId`). Original spec referenced a stale nested `messages/<mid>/info.json` shape; corrected from disk samples
- [x] 6.4 Atomic per-file write: tmp + fsync + rename
- [x] 6.5 Idempotent: per-file `skipped: already-clean` audit line when the file has provider fields already in family form
- [x] 6.6 Sanity-check `accounts.json` families[]; throw when key not in `knownFamilies`
- [x] 6.7 `.migration-state.json` marker written per data-schema
- [x] 6.8 `--verify` subcommand: read-only re-walk, non-zero exit if any rewrite would still happen

## 7. Daemon boot guard (DD-6)

- [x] 7.1 Marker read at `cli/cmd/serve.ts:handler` (anchored at the serve entry point rather than module-top in `index.ts` so unrelated CLI commands and the migration script itself are not blocked) — see `server/migration-boot-guard.ts`
- [x] 7.2 `MigrationRequiredError` thrown on missing or non-`"1"` version; remediation hint includes the migration script path
- [x] 7.3 Exit code 1, no silent fallback

## 8. Tests + documentation

- [x] 8.1 `packages/opencode/test/account/provider-account-decoupling.test.ts` — `assertFamilyKey` accepts family / rejects per-account / rejects empty; `Auth.get(unknown)` → UnknownFamilyError; `Auth.get(family)` with no active → NoActiveAccountError; `Auth.get(family, accountId)` returns matching auth blob (6 tests, all passing)
- [x] 8.2 `packages/opencode/test/scripts/migrate-decoupling.test.ts` — subprocess-driven dry-run / apply / verify / idempotence tests against synthetic fixture (3 tests, all passing)
- [x] 8.3 `specs/architecture.md` — added `### Provider / Family / Account Naming` section; struck through the obsolete `enforceCodexFamilyOnly` paragraph
- [x] 8.4 `docs/events/event_2026-05-03_provider-account-decoupling-cutover.md` records phase-by-phase landing + cutover script + rollback path

## 9. Cutover (ops, after merge)

> Operator-driven; daemon must be stopped during the window. Full runbook + rollback path: [docs/events/event_2026-05-03_provider-account-decoupling-cutover.md](../../docs/events/event_2026-05-03_provider-account-decoupling-cutover.md). Spec promotes `verified → living` after smoke (§ 9.6) passes.

- [ ] 9.1 `opencode daemon stop`
- [ ] 9.2 `bun run packages/opencode/scripts/migrate-provider-account-decoupling.ts --dry-run` — review diff
- [ ] 9.3 `bun run packages/opencode/scripts/migrate-provider-account-decoupling.ts --apply` — backup + sweep + marker
- [ ] 9.4 Smoke check: cat `.migration-state.json`; verify backup tarball exists
- [ ] 9.5 Start new daemon binary; confirm boot succeeds (marker check passes)
- [ ] 9.6 End-to-end smoke: codex completion on `yeats.luo@thesmart.cc`; force a transient error; verify same-family fallback to a different codex account succeeds
