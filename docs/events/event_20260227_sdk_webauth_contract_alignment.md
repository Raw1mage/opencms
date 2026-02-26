# Event: SDK WebAuth Contract Alignment

Date: 2026-02-27
Target: `cms`

## Scope

- Align OpenAPI contract for `global.auth.login` with runtime validation.
- Add SDK-side fallback helpers for optional `provider.npm` fields.

## Changes

1. `packages/opencode/src/server/routes/global.ts`
   - Added explicit OpenAPI `requestBody` schema for `POST /global/auth/login`.
   - Contract now marks `username` and `password` as required at API spec level.
2. `packages/sdk/js/src/v2/client.ts`
   - Added `resolveProviderNpm()` helper.
   - Added `resolveModelProviderNpm()` helper.
   - Added `loginGlobalWebAuth()` helper to enforce required credentials at call sites.
   - Both helpers provide stable fallback to `@ai-sdk/openai-compatible` when `npm` is undefined.

## Notes

- Generated SDK files are expected to update after regeneration to reflect stricter login body contract.
- This keeps optional `provider.npm` semantics while offering a migration-safe utility path for consumers.

## Validation

- `bun run build` in `packages/sdk/js` ✅
- `bun run typecheck` in `packages/sdk/js` ✅
