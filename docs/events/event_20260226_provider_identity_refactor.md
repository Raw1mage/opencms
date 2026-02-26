# Event: Provider Identity Refactor (family inference hardening)

Date: 2026-02-26
Status: Done

## 1. Problem Statement

- cms already adopts a 3D coordinate model (`provider`, `account`, `model`) but parts of runtime still used fuzzy `providerId -> family` inference.
- Symptom: models.dev providers with instance suffix (example: `nvidia-work`) could be stored under non-canonical account family keys, causing provider/model visibility inconsistencies.

## 2. Root Cause

- Legacy string heuristics existed in auth/account resolution paths.
- Family resolution mixed canonical IDs and instance-like IDs.
- Existing storage could contain non-canonical family keys from prior behavior.

## 3. Decisions

1. **Auth family resolution switched to canonical-aware resolver**
   - Source of truth for known families = `Account.PROVIDERS` + `models.dev` providers + existing account family keys.
   - Resolution order: exact family > account-id pattern (`{family}-{api|subscription}-...`) > longest known family prefix.
   - Avoid fallback-to-first-token behavior.

2. **Account storage normalization added during load**
   - Normalize family keys like `nvidia-work` back to canonical family (`nvidia`) when resolvable.
   - Merge account payloads safely (collision suffixing) instead of dropping entries.

3. **Deprecated fuzzy parse fallback reduced**
   - `Account.parseProvider()` no longer treats arbitrary dashed IDs as a valid family by default.

4. **Canonical resolver promoted to runtime primitive**
   - Added `Account.resolveFamily()` / `Account.resolveFamilyOrSelf()` and refactored provider/session/rotation/route callsites away from legacy parse-family usage.

5. **Provider inheritance heuristic replaced**
   - Replaced regex account-suffix inheritance in `provider/provider.ts` with canonical resolver-driven family inheritance.

6. **Operational migration command added**
   - Added `opencode auth migrate-identities` to run explicit normalization and print move reports.

## 4. Changed Files

- `packages/opencode/src/auth/index.ts`
- `packages/opencode/src/account/index.ts`
- `packages/opencode/src/provider/provider.ts`
- `packages/opencode/src/session/llm.ts`
- `packages/opencode/src/session/processor.ts`
- `packages/opencode/src/account/rotation3d.ts`
- `packages/opencode/src/session/image-router.ts`
- `packages/opencode/src/provider/health.ts`
- `packages/opencode/src/server/routes/provider.ts`
- `packages/opencode/src/agent/score.ts`
- `packages/opencode/src/cli/cmd/model-smoke.ts`
- `packages/opencode/src/cli/cmd/auth.ts`
- `packages/opencode/test/auth/family-resolution.test.ts`
- `packages/opencode/test/account/family-normalization.test.ts`
- `packages/opencode/test/provider/provider-cms.test.ts`
- `docs/ARCHITECTURE.md`

## 5. Risk Assessment

- **Medium**: custom providers that intentionally relied on ambiguous dashed IDs may now require explicit canonical registration.
- **Mitigation**:
  - Keep explicit unknown-provider path (`custom-provider-work` remains explicit when not resolvable to known family).
  - Add regression tests for both canonical mapping and unknown-provider non-collapse behavior.

## 6. Validation Plan

- Run targeted tests:
  - `packages/opencode/test/auth/family-resolution.test.ts`
  - `packages/opencode/test/account/family-normalization.test.ts`
  - `packages/opencode/test/provider/provider-cms.test.ts`
- Run focused provider/account test subset for regression.
