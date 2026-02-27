# Event: Align web model selector semantics to cms TUI admin (hotfix)

Date: 2026-02-27
Status: Done

## Source of truth

- Treated `packages/opencode/src/cli/cmd/tui/component/dialog-admin.tsx` (cms TUI admin) as canonical behavior reference.

## Problem

- Web selector regressed to empty provider/account/model columns in curated mode.
- Root cause was applying favorites-only family gating in web provider list while web favorite storage is not guaranteed to match TUI state.

## Alignment decisions

1. Curated mode in web should behave like TUI non-showall filtering semantics (hide-filtered list), not favorites-only family gating.
2. `Show all` should continue to expose full model list.
3. Visibility toggle should invert current visible state, not explicit `enabled` flag.

## Changes

- Updated `packages/app/src/components/dialog-select-model.tsx`:
  - Replaced `favoriteFamilies` gating with `curatedFamilies` derived from `local.model.visible(...)`.
  - Curated model filtering now uses `local.model.visible(key)`.
  - Row eye/toggle now uses `local.model.visible(key)` for state and inversion.

## Validation

- `bun x tsc --noEmit --project packages/app/tsconfig.json` ✅
- `./webctl.sh build-frontend && ./webctl.sh restart && ./webctl.sh status` ✅ (healthy true)

## Follow-up (structural)

- Web/TUI still use different persistence backends for favorites/hidden metadata.
- To achieve strict parity, add a shared server-backed model preference API and migrate web selector state reads to that source.
