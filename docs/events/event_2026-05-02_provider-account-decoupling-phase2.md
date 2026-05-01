# 2026-05-02 — provider-account-decoupling phase 2 (registry shape rewrite)

Spec: [specs/provider-account-decoupling/](../../specs/provider-account-decoupling/)
Branch: `beta/provider-account-decoupling`
Builds on: phase 1 (event_2026-05-02_provider-account-decoupling-phase1.md)

## Phase

2 — Registry shape rewrite (DD-1, DD-4)

## Done

- 2.1 Added `Provider.AccountState` zod type (options/active/email/coolingDownUntil/cooldownReason/displayName) and an `accounts: Record<accountId, AccountState>` field on `Provider.Info`. Default `{}`.
- 2.2 Rewrote the per-account populate loop at [provider.ts:1467-1614](../../packages/opencode/src/provider/provider.ts#L1467-L1614). Old behaviour wrote `database[effectiveId] = {...}` and `mergeProvider(effectiveId, ...)` where `effectiveId === accountId`. New behaviour:
  - `mergeProvider(family, ...)` ensures the family-level entry exists (assertFamilyKey now passes — this was the trip wire from phase 1).
  - `providers[family].accounts[accountId] = AccountState` holds per-account options/credentials/cooldown.
  - `model.providerId = family` everywhere (was `model.providerId = effectiveId`).
  - Active account's display attributes (active/email/coolingDownUntil/cooldownReason) mirrored onto the family entry so existing UIs keep reading the same shape.
- 2.3 Rewrote per-account auth loader + fetch inheritance at [provider.ts:1726-1797](../../packages/opencode/src/provider/provider.ts#L1726-L1797). Reads/writes go through `familyEntry.accounts[accountId].options`, not `providers[accountId].options`. Phase 3 will switch the inner `loadAuth(accountId)` call to two-arg `(family, accountId)`; for now Auth.get still accepts the legacy form.
- 2.4 Audited every `model.providerId = ...` assignment in provider.ts (16 sites). Survivors all set family-level providerIds: `database[targetID]` clones (1185, family-level), populate loop (now `family`), copilotID iterations (1858/1863, both family-level), wrapped fetch logger (2163-2355, propagates whatever model carries — now always family), parseModel (2786, takes user input). The legacy `resolveExecutionModel` at 2476 will safely no-op once its `providers[accountProviderId]` lookup misses (phase 4 rewrites it properly).
- 2.5 Cleaned up the "propagate base options to per-account providers" loop at 1871-1890 — same `providers[family].accounts[accountId]` shape. `mergeProvider` itself didn't need modification; the only previously-offending caller was rerouted in 2.2.
- 2.6 Tests:
  - `bun test packages/opencode/test/account/` → **24 pass / 0 fail** (including `codex-family-only-fallback.test.ts`, `family-normalization.test.ts`, `account-cache.test.ts`)
  - `bun test packages/opencode/test/provider/` → 131 pass / 9 fail. The 9 failures are pre-existing on `main` (`ProviderTransform.variants` for github-copilot xhigh / anthropic max thinking variants); unrelated to registry shape. Per phase 2.6 scope ("fix only registry-shape-related failures") these are deferred.

## Key decisions

No new DDs added during phase 2. All work executed exactly as DD-1 / DD-4 described.

## Validation

- 24/24 account tests green in beta env (XDG isolated)
- registry boundary trip wire from phase 1 now stops firing — populate loop only writes to families
- `grep -nE "providers\[(accountId|effectiveId)\]" packages/opencode/src/provider/provider.ts` → no more leaking writes (former offenders rewritten or deleted)

## Drift / sync

None. tasks.md updated in lockstep; no scope creep.

## Remaining before next state

Phase 3 (Auth.get two-arg signature). After phase 3, `loadAuth(accountId)` → `loadAuth(family, accountId)` and the legacy single-arg path is removed entirely.
