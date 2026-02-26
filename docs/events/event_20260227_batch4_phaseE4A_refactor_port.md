# Event: Batch-4 Phase E4-A rewrite-port (settings/feed UX)

Date: 2026-02-27
Status: Done

## Scope

- `ae98be83b` fix(desktop): restore settings header mask
- `63a469d0c` tweak(ui): refine session feed spacing
- `8b99ac651` tweak(ui): tone down reasoning emphasis
- `8d781b08c` tweak(ui): adjust session feed spacing
- `f07e87720` fix(app): remove double-border in share button
- `ce2763720` fix(app): better sound effect disabling ux

## Decision summary

- Ported:
  - `ae98be83b`
  - `63a469d0c`
  - `8b99ac651`
  - `8d781b08c`
- Integrated/no-op:
  - `f07e87720` (share button already includes conditional `border-r-0` logic)
  - `ce2763720` (sound "None" option and stop/preview UX flow already integrated)

## Changes

- `packages/ui/src/styles/theme.css`
  - introduced `--surface-stronger-non-alpha` alias in light/dark themes.
- settings header masks now use `--surface-stronger-non-alpha` in:
  - `packages/app/src/components/settings-general.tsx`
  - `packages/app/src/components/settings-keybinds.tsx`
  - `packages/app/src/components/settings-models.tsx`
  - `packages/app/src/components/settings-permissions.tsx`
  - `packages/app/src/components/settings-providers.tsx`
  - `packages/app/src/components/settings-accounts.tsx` (cms-specific extension for consistency)
- `packages/ui/src/components/message-part.css`
  - tightened text-part top spacing (`32px -> 24px`).
  - toned down reasoning visual emphasis: normal line-height, normal font style, weak text color, weak strong/bold color.

## Validation

- `bun turbo typecheck --filter=@opencode-ai/app --filter=@opencode-ai/ui` ✅

## Notes

- Rewrite-only policy respected (no merge/cherry-pick).
