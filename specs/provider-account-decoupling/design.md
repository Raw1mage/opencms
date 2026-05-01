# Design: provider-account-decoupling

## Context

Today the runtime conflates two distinct identifiers:

- **family** — `"codex"`, `"openai"`, `"anthropic"`, etc. The thing that has a Provider SDK, an OAuth flow, a model catalog.
- **accountId** — opaque per-account identifier. Persisted in `accounts.json` under `families.<family>.accounts.<accountId>`. Today happens to be shaped like `<family>-(api|subscription)-<slug>` because [`Account.generateId`](packages/opencode/src/account/index.ts#L776-L779) builds it that way.

The bug pattern: this opaque accountId string gets stored *as a providerId* in:
- `providers[]` registry map ([provider.ts:1593](packages/opencode/src/provider/provider.ts#L1593))
- `Auth.get(providerId)` calls ([auth/index.ts:82-115](packages/opencode/src/auth/index.ts#L82-L115))
- `Model.providerId` field on emitted models
- Bus events and message persistence (sometimes)

Then comparison code (`enforceCodexFamilyOnly`, `parseProvider`, `resolveFamilyFromKnown`) has to do regex / longest-prefix / dynamic resolution to recover the family from the accountId. Every such recovery site is a potential bug. The 2026-05-02 CodexFamilyExhausted incident is one such site failing closed.

## Goals / Non-Goals

### Goals

- Registry, Auth, getSDK, Model.providerId all use family form **only**.
- AccountId stays opaque and unchanged in storage; nothing on disk has to be renamed.
- All "is this provider in the codex family?" checks become trivial `=== "codex"`.
- Hotfix in [rotation3d.ts:746-775](packages/opencode/src/account/rotation3d.ts#L746-L775) becomes redundant and is deleted.

### Non-Goals

- AccountId string format change (kept as-is — `codex-subscription-foo` remains a valid accountId).
- OAuth token storage format change.
- Cross-family rotation behaviour change.
- Any frontend / sidebar change (already uses clean three-tuple form).

## Decisions

- **DD-1** — *Registry key is family.* `providers: Record<family, Provider.Info>`. Per-account auth/options/state is moved into a sub-map on `Provider.Info.accounts: Record<accountId, AccountState>`. Reason: makes the dimensions visible in the type, removes mixed-key ambiguity. Enforcement: throws `RegistryShapeError` on non-family key insertion at registry boundary.

- **DD-2** — *Auth.get becomes two-arg.* `Auth.get(family: string, accountId?: string): AuthBlob | undefined`. Single-arg legacy form is removed (no overload). Reason: two-arg form is the actual semantic; overload would let bugs hide behind a permissive shape. AGENTS.md rule 1 (no silent fallback) means we throw on unknown family.

- **DD-3** — *getSDK becomes (family, accountId, modelId).* Reads auth via `Auth.get(family, accountId)` and SDK template from `providers[family]`. Reason: matches the (provider, account, model) tuple exactly.

- **DD-4** — *Model.providerId always equals a family.* When models are produced from per-account customisations, the customisation lives on a separate `ModelDispatch { family, accountId, modelId }` carrier passed alongside `Model`, not encoded into `Model.providerId`. Reason: `Model` is a description; dispatch context is per-call. Conflating them is the original sin.

- **DD-5** — *Rotation comparisons are pure equality.* `enforceCodexFamilyOnly` and the 2026-05-02 step 3b hotfix are both deleted. The only family check needed is `candidate.providerId === current.providerId`, which is now correct by construction.

- **DD-6** — *Storage migration is one-shot, ops-driven, daemon-stopped.* No dual-read window. Daemon refuses to start if migration marker is missing or stale. Reason: user explicitly chose single cutover (proposal §Constraints, 2026-05-02). Simpler and less code than dual-read; rollback is via backup, not code.

- **DD-7** — *Backup is mandatory and recorded.* Migration script first writes `~/.local/share/opencode/storage/.backup/provider-account-decoupling-<ISO-timestamp>/` containing accounts.json + a tar of `storage/session/`. Path is recorded in `.migration-state.json` and in `.state.json.history`. Reason: single cutover means rollback = restore-from-backup; the backup must be findable.

- **DD-8** — *Compatibility shims are forbidden.* No "if it looks like accountId, treat it as family" parsers, no `parseProvider` calls in the new code paths, no `resolveFamilyOrSelf` fallback. Reason: shims defeat the purpose of the refactor and the bug class would survive.

- **DD-9** — *`Account.parseProvider` and `Account.resolveFamilyFromKnown` regex paths stay, scoped to the migration script only.* They are needed exactly once — to recover family from a legacy on-disk per-account providerId during migration. After migration they are dead code in the runtime. Marked with `@internal:migration-only` JSDoc. Reason: needed for migration correctness; documenting the scope prevents future code from re-introducing the dispatch-time parser.

## Risks / Trade-offs

- **R-1: Hidden caller passes accountId where family is expected.** Mitigation: the registry's `RegistryShapeError` and `Auth.get`'s `UnknownFamilyError` will throw at runtime. Caught by the new `provider-account-decoupling.test.ts` suite plus a manual end-to-end smoke (codex completion + same-family fallback).
- **R-2: Migration script corrupts session storage.** Mitigation: DD-7 backup; idempotency requirement (Spec §Acceptance); dry-run mode before mutating; per-file write uses atomic rename.
- **R-3: Plugin / custom-loader code reaches into `providers[accountId]`.** Mitigation: inventory called out [custom-loaders-def.ts:35,109,276](packages/opencode/src/provider/custom-loaders-def.ts) and [agent.ts:381](packages/opencode/src/agent/agent.ts#L381) as suspect sites; tasks include explicit re-route via the new `Provider.Info.accounts` sub-map.
- **R-4: Bus event consumers (frontend) crash on legacy events.** Mitigation: bus events on the wire are already family-form per the 2026-05-02 log evidence; only stored history needed migration. No frontend change required.
- **R-5: Rate-limit tracker rebuild misclassifies on first restart.** Mitigation: DD-6 explicitly accepts in-memory tracker rebuild; cooldown is short-lived and self-healing; no migration of tracker state.
- **R-6: Beta vs main XDG isolation.** Mitigation: migration script reads `OPENCODE_DATA_HOME` if set; runs only against the requested env; refuses if both `~/.config/opencode` and `~/.local/share/opencode` lack the marker (no cross-env writes).

## Critical Files

- [packages/opencode/src/account/index.ts](packages/opencode/src/account/index.ts) — `Account.generateId`, `resolveFamilyFromKnown`, `parseProvider`. After this refactor: `generateId` unchanged; the two parsers gain `@internal:migration-only`.
- [packages/opencode/src/auth/index.ts](packages/opencode/src/auth/index.ts) — `Auth.get` signature change (DD-2); `Auth.set` already family-keyed via `resolveProviderOrSelf`, just confirm.
- [packages/opencode/src/provider/provider.ts](packages/opencode/src/provider/provider.ts) — registry shape (DD-1), `getSDK` signature (DD-3), populate loop at L1459-L1605, fetch inheritance at L1697-L1723. Major surgery here.
- [packages/opencode/src/provider/custom-loaders-def.ts](packages/opencode/src/provider/custom-loaders-def.ts) — verify Auth.get callers expect family form.
- [packages/opencode/src/account/rotation3d.ts](packages/opencode/src/account/rotation3d.ts) — delete `enforceCodexFamilyOnly` (L830-L851), delete step 3b same-family skip (L746-L775 hotfix), simplify candidate building.
- [packages/opencode/src/agent/agent.ts](packages/opencode/src/agent/agent.ts):381 — `Auth.get(defaultModel.providerId)` confirm family form post-DD-4.
- [packages/opencode/src/mcp/app-registry.ts](packages/opencode/src/mcp/app-registry.ts):360 — `Auth.get(accountId)` rewrite to two-arg form.
- New: `packages/opencode/scripts/migrate-provider-account-decoupling.ts` — one-shot migration; backup + idempotent + marker file.
- New: `packages/opencode/src/provider/registry-shape.ts` — `RegistryShapeError`, `UnknownFamilyError`, `NoActiveAccountError`, `MigrationRequiredError` definitions and the registry-boundary assertion helper.

## Migration Sequence

1. Daemon stop (`opencode daemon stop`).
2. Operator runs `bun run packages/opencode/scripts/migrate-provider-account-decoupling.ts --dry-run` → reviews diff.
3. Operator runs same script without `--dry-run`:
   1. Backup snapshot to `.backup/provider-account-decoupling-<ts>/`.
   2. Walk `storage/session/**/messages/**/info.json` and `parts/*.json`; for each `providerId` field that matches `<known-family>-(api|subscription)-<slug>`, replace with the matched family. Atomic rename per file.
   3. Walk `storage/session/**/info.json` for `execution.providerId` fields — same transform.
   4. Sanity-check `accounts.json`: every `families.<X>` key is in `Account.knownFamilies()`. Fail loud if not.
   5. Write `.migration-state.json` with marker `{ version: "1", migrated_at: <ts>, backup_path }`.
4. Operator deploys new binary, starts daemon. Daemon checks marker on boot; refuses to start if missing or `version != "1"`.

## Sync Plan

After implementation, `specs/architecture.md` gains a new `## Provider/Family/Account Naming` section pointing at this spec. Any future provider family must follow DD-1..DD-4 by default.
