# Event: origin/dev refactor item - reasoning summaries toggle

Date: 2026-02-23
Status: Done

## Source

- `2a904ec56` feat(app): show/hide reasoning summaries

## Refactor

- Added `general.showReasoningSummaries` to settings store and defaults in:
  - `packages/app/src/context/settings.tsx`
- Added settings UI toggle under Feed section:
  - `packages/app/src/components/settings-general.tsx`
- Wired setting into session rendering:
  - `packages/app/src/pages/session/message-timeline.tsx`
  - `packages/ui/src/components/session-turn.tsx`
  - `packages/ui/src/components/message-part.tsx`
- Added new i18n keys:
  - `settings.general.row.reasoningSummaries.title`
  - `settings.general.row.reasoningSummaries.description`

## Validation

- `bun run --cwd /home/pkcs12/projects/opencode/packages/ui typecheck` ✅
- `bun run --cwd /home/pkcs12/projects/opencode/packages/app typecheck` ⚠️
  - Existing unrelated baseline issue remains:
    - `src/context/local.tsx(94,62): Property 'split' does not exist on type 'Model'`
