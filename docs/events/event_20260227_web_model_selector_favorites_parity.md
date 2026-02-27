# Event: Web model selector favorites parity with TUI admin panel

Date: 2026-02-27
Status: Done

## Symptom

- In web model selector, **精選 (favorites)** mode did not match TUI admin panel behavior.
- For providers like Nvidia, right-column model list could appear empty even when TUI showed favorite models.

## Root Cause

1. Favorites mode in web dialog was filtered by `enabled` visibility state, not `favorite` state.
2. Provider list in favorites mode was built from a broad provider universe and did not require the provider family to actually have favorite models.

## Changes

- Updated `packages/app/src/context/local.tsx`
  - Exposed model favorite APIs on local context:
    - `local.model.favorite(modelKey)`
    - `local.model.toggleFavorite(modelKey)`

- Updated `packages/app/src/components/dialog-select-model.tsx`
  - In favorites mode, right-column models now filter by `local.model.favorite(...)`.
  - In favorites mode, provider list now includes only families that actually have favorite models (while still respecting disabled provider filtering).

## Validation

- `bun x tsc --noEmit --project packages/app/tsconfig.json` ✅

## Decision Note

- Keep mode semantics explicit:
  - `favorites` = favorite models only
  - `all` = full provider model list
- This aligns web UI behavior with TUI admin panel expectations.
