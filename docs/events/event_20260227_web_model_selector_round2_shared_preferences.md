# Event: Web model selector round2 — shared model preferences with cms TUI

Date: 2026-02-27
Status: Done

## Goal

- Continue parity work by reducing the biggest structural gap: Web and TUI using different persistence for model favorites/hidden state.

## Source of Truth

- TUI admin behavior remains canonical (`packages/opencode/src/cli/cmd/tui/component/dialog-admin.tsx`).
- TUI persistence shape (`favorite/hidden/hiddenProviders`) in `model.json` is treated as canonical preference storage shape.

## Architecture Change

### 1) Server exposes shared model preference API

Added route:

- `packages/opencode/src/server/routes/model.ts`

Endpoints:

- `GET /api/v2/model/preferences`
- `PATCH /api/v2/model/preferences`

Storage behavior:

- Reads/writes `${Global.Path.state}/model.json`
- Updates `favorite`, `hidden`, `hiddenProviders`
- Preserves unrelated fields (`recent`, `variant`, etc.)

Mounted in app:

- `packages/opencode/src/server/app.ts` via `api.route("/model", ModelRoutes())`

### 2) Web models context syncs with shared preferences

Updated:

- `packages/app/src/context/models.tsx`

Behavior:

- On ready, fetches shared preferences from `/api/v2/model/preferences`
- Applies `favorite/hidden` into local model user state
- On favorite/visibility mutations, debounced PATCH back to shared API
- Normalizes provider IDs to family-style IDs for cross-surface consistency

## Why this matters for multi-model handoff

- Selector semantics are no longer split purely by browser-local preference store.
- Future model/operator can inspect one server route + one context module to reason about persistence flow.

## Validation

- `bun x tsc --noEmit --project packages/app/tsconfig.json` ✅
- `bun x tsc --noEmit --project packages/opencode/tsconfig.json` ⚠️ baseline-known antigravity legacy errors only
  - `packages/opencode/src/plugin/antigravity/plugin/storage.legacy.ts`
- `bun test packages/app/src/components/model-selector-state.test.ts` ✅
- `./webctl.sh build-frontend && ./webctl.sh restart && ./webctl.sh status` ✅ (`healthy: true`)

## Remaining gap

- Web still does local projection/merge around shared preferences for compatibility with existing `model.v1` structure.
- A full strict-unification pass should migrate to a dedicated shared preference abstraction used by both TUI and Web directly.

## Round2b canonicalization + mode alignment

- User clarified canonical tri-state constraints:
  - `favorite/show`
  - `unfavorite/show`
  - `unfavorite/hidden`
  - invariants:
    - favorite => show
    - hide => unfavorite
- Applied in `packages/app/src/context/models.tsx`:
  - `toggleFavorite(true)` forces `visibility: show`
  - `setVisibility(false)` forces `favorite: false`
  - remote apply canonicalizes hidden rows to `favorite: false`
  - remote write preserves `hiddenProviders` from server state (no hard reset to `[]`)
- Selector mode in `packages/app/src/components/dialog-select-model.tsx`:
  - `all` => no provider/model filter
  - `favorites` => provider families derived from favorite models; model rows filtered by favorite
  - model rows now display favorite marker (`★`) in all-mode visibility

## Round2 follow-up hotfix

- Symptom: provider column did not react to favorites/curated mode and effectively behaved like show-all.
- Fix: `packages/app/src/components/dialog-select-model.tsx`
  - Added `visibleFamilies` derived from `local.model.visible(...)`.
  - Added `providersForMode`:
    - `all` => all provider rows
    - `favorites` => provider rows filtered by `visibleFamilies`
  - Updated provider rendering and selection fallback to use `providersForMode`.

Validation (follow-up):

- `bun x tsc --noEmit --project packages/app/tsconfig.json` ✅
- `./webctl.sh build-frontend && ./webctl.sh restart && ./webctl.sh status` ✅ (`healthy: true`)
