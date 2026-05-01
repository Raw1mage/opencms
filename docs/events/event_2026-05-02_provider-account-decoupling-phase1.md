# 2026-05-02 — provider-account-decoupling phase 1 (boundary infrastructure)

Spec: [specs/provider-account-decoupling/](../../specs/provider-account-decoupling/)
Branch: `beta/provider-account-decoupling` in `/home/pkcs12/projects/opencode-beta`
Backup taken: `/home/pkcs12/.local/share/opencode/storage/.backup/pre-beta-provider-account-decoupling-20260501T180314Z/`

## Phase

1 — Boundary infrastructure (trip wire only; no behaviour change yet)

## Done

- 1.1 Created [packages/opencode/src/provider/registry-shape.ts](../../packages/opencode/src/provider/registry-shape.ts) — exports `RegistryShapeError`, `UnknownFamilyError`, `NoActiveAccountError`, `MigrationRequiredError` (zod-typed via `NamedError`), plus `assertFamilyKey(providerId, knownFamilies)` that throws on miss with a remediation hint
- 1.2 (folded into 1.1) — `assertFamilyKey` lives in the same file
- 1.3 Wired `assertFamilyKey` into [`mergeProvider`](../../packages/opencode/src/provider/provider.ts#L1054) — captures `Account.knownFamilies({ includeStorage: true })` once at init (sync closure constraint) and validates every `providers[X] = ...` write
- 1.4 Tagged [`Account.resolveFamilyFromKnown`](../../packages/opencode/src/account/index.ts#L254) and [`Account.parseProvider`](../../packages/opencode/src/account/index.ts#L803) with `@internal:migration-only` JSDoc per DD-9; behaviour unchanged

## Key decisions

No new DDs added during phase 1. All four tasks executed exactly as design.md DD-1/DD-9 prescribed.

## Validation

- TypeScript compile: not yet run on beta worktree (phase 2 will compile after registry rewrite — phase 1 alone leaves the trip wire armed and the populate loop still firing, so a `tsc --noEmit` would pass type-wise but the daemon would throw `RegistryShapeError` at first init call)
- No tests run — phase 1 expressly leaves the runtime broken until phase 2; spec acknowledges this ("tests will fail loudly until phase 2 lands")

## Drift / sync

None. tasks.md updated in lockstep.

## Remaining before next state

Phase 2 (registry shape rewrite) is next. After phase 2, the trip wire from phase 1 should stop firing and `bun test packages/opencode/test/account/` is the first meaningful gate.
