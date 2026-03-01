# Event: web footer provider/account/quota alignment

Date: 2026-03-02
Status: Done

## Symptom

- In web prompt footer, selecting OpenAI model/account could show mismatched provider/account labels.
- Quota hint request could use a non-canonical provider ID, causing OpenAI weekly hint to be missing or inconsistent.

## Root Cause

1. Model selection flow could persist account-like/provider-instance IDs into `local.model.current().provider.id` instead of canonical provider family.
2. Footer quota fetch in `prompt-input.tsx` used raw `model.provider.id` directly for `/api/v2/account/quota`, while backend quota routing resolves by provider family.
3. Footer provider label trusted raw provider name/id, which could surface non-canonical identity strings.

## Changes

- `packages/app/src/components/dialog-select-model.tsx`
  - Prevented account-like IDs from being selected as provider IDs.
  - Resolved selection provider strictly from in-family model candidates, preferring canonical family provider.

- `packages/app/src/components/prompt-input.tsx`
  - Normalized quota request key/query to provider family (`normalizeProviderFamily(...)`) before calling `/api/v2/account/quota`.
  - Normalized provider display label in footer to canonical family label (e.g., `OpenAI`, `Claude CLI`).

### Follow-up (after user screenshot)

- Observed that some model rows can carry account-like `provider.id` while canonical family is available on `model.family`.
- Updated both selector and footer logic to prefer `model.family` as family source of truth:
  - `dialog-select-model.tsx`: family matching/selection now uses `familyOfModel(model)` (`model.family ?? model.provider.id`).
  - `prompt-input.tsx`: provider label + quota hint now derive family from `model.family ?? model.provider.id`.

## Validation

- `bun run --filter @opencode-ai/app typecheck` ✅

## Notes

- Existing unrelated working-tree changes in `packages/app/src/context/sync.tsx` and `packages/app/src/pages/session/index.tsx` were left untouched.
