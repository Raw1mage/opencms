# Batch9C Usage Table BYOK + Session Display (rewrite-only)

Date: 2026-02-27
Source: `origin/dev` (`284251ad6`, `5596775c3`)
Target: `cms`

## Scope

- Port usage-visibility improvements:
  - BYOK cost labeling in usage table
  - session identifier column in usage table

## Changes

1. `packages/console/app/src/routes/workspace/[id]/usage-section.tsx`
   - Added `workspace.usage.table.session` column.
   - Added BYOK-specific cost rendering branch (`workspace.usage.byok`).
   - Session cell now displays trailing 8 chars from `usage.enrichment?.sessionID` (fallback `-`).
2. `packages/console/app/src/routes/zen/util/handler.ts`
   - Usage enrichment now records plan as `sub` or `byok`.
   - Added session identifier to enrichment payload (`sessionID` trimmed to 30 chars).
   - Billing balance deduction keeps zero-charge behavior for `free` and `byok`.
3. `packages/console/core/src/schema/billing.sql.ts`
   - Expanded `UsageTable.enrichment` type to union:
     - `{ plan: "sub"; sessionID?: string }`
     - `{ plan: "byok"; sessionID?: string }`
4. i18n updates across all supported locale dictionaries:
   - Added `workspace.usage.table.session`
   - Added `workspace.usage.byok`

## Validation

- `bun run typecheck` in `packages/console/app` ✅
- `bun run typecheck` in `packages/console/core` ✅

## Notes

- Session display is implemented through existing `enrichment` JSON to avoid introducing new physical DB columns in this batch.
