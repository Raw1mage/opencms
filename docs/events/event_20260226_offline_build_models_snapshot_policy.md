# Event: offline build and models snapshot update policy

Date: 2026-02-26
Status: Done

## Goal

Make `bun run build` offline-first and deterministic by removing default network fetch for models snapshot generation.

## Decisions

- `script/build.ts` no longer refreshes `models-snapshot.ts` by default.
- Snapshot refresh is now opt-in via:
  - `bun run build -- --refresh-models`
  - or `MODELS_DEV_API_JSON=/abs/path/to/api.json bun run build`
- Added dedicated online update mechanism:
  - `bun run models:update-snapshot`
- Added built-in help and discoverability scripts for users who do not remember detailed CLI flags.

## Changes

- `script/build.ts`
  - Added `--refresh-models` flag.
  - Guarded models.dev fetch behind explicit opt-in.
  - Added explicit offline-default log message.
- `script/update-models-snapshot.ts`
  - New standalone updater for `packages/opencode/src/provider/models-snapshot.ts`.
- `package.json`
  - Added script: `models:update-snapshot`.
  - Added discoverability aliases: `build:help`, `build:with-models`, `models:update-snapshot:help`.

## Help UX

- `bun run build -- --help` now prints offline-default behavior and all supported options.
- `bun run models:update-snapshot --help` now prints updater usage and env vars.
- Build default log now explicitly points to `--refresh-models` when snapshot refresh is skipped.

## Validation

- Change scope verified by code inspection:
  - build path keeps existing snapshot when no refresh flags are provided.
  - snapshot update path remains available through dedicated command.
