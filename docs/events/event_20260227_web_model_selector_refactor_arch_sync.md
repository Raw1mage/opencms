# Event: Web model selector refactor (cms TUI admin aligned, code+doc sync)

Date: 2026-02-27
Status: Done

## Single Source of Truth

- Canonical behavior reference: `packages/opencode/src/cli/cmd/tui/component/dialog-admin.tsx`
- Scope for this round: Web 3-column selector (`provider / account / model`) behavior parity for mode semantics and list derivation.

## Problem Statement

- Previous fixes mixed `favorite / enabled / visible` semantics and embedded business logic directly in UI rendering.
- Result: regressions (empty provider/account columns, inconsistent curated/all behavior) and difficult handoff across models.

## Architecture Decision (for handoff stability)

### 1) Move selector rules into pure state module

New module:

- `packages/app/src/components/model-selector-state.ts`

Responsibilities:

- `normalizeProviderFamily(id)`
- `buildProviderRows(...)`
- `buildAccountRows(...)`
- `filterModelsForMode(...)`

Design intent:

- Keep all selector derivation logic deterministic and testable outside Solid UI runtime.
- Make UI component consume already-shaped rows instead of re-encoding rules inline.

### 2) Web selector behavior boundary (this round)

- Provider/Account columns are built from provider universe + account families (not gated by favorites).
- Mode switch controls **model filtering only**:
  - `favorites` => `local.model.visible(...)`
  - `all` => full list for selected provider family

This prevents provider/account column collapse while keeping curated/all semantics explicit.

## Implementation Changes

### Code

- Added: `packages/app/src/components/model-selector-state.ts`
- Updated: `packages/app/src/components/dialog-select-model.tsx`
  - Removed inline provider/account/model derivation blocks
  - Delegated to state module helpers

### Tests

- Added: `packages/app/src/components/model-selector-state.test.ts`
  - provider row derivation
  - account row ordering + cooldown message
  - favorites mode filtering
  - all mode filtering

## Validation

- `bun x tsc --noEmit --project packages/app/tsconfig.json` ✅
- `bun test packages/app/src/components/model-selector-state.test.ts` ✅
- `./webctl.sh build-frontend && ./webctl.sh restart && ./webctl.sh status` ✅ (`healthy: true`)

## Multi-model Handoff Notes

If another model takes over, use this sequence:

1. Read this event file first.
2. Read `model-selector-state.ts` before touching `dialog-select-model.tsx`.
3. Preserve contract:
   - provider/account are source-derivation layers,
   - mode affects model filtering only.
4. Run the same validation trio above before claiming parity changes.

## Remaining Structural Gap (explicit)

- TUI favorites/hidden metadata is persisted in `model.json` (core state).
- Web currently still uses local persisted model preferences in app context.
- For strict cross-surface parity, introduce server-backed model preference endpoints and migrate web state source in a dedicated round.
