# Event: Dev startup failure due to invalid plugin package version

- **Date**: 2026-02-10
- **Scope**: Local runtime bootstrap (`bun run dev`)
- **Severity**: High (startup blocked / unstable)

## Symptom

- `bun run dev` could not start stably in local terminal session.
- `debug.log` showed repeated `opencode install` failures during startup.

## Reproduction (minimal)

1. Run `bun run dev`.
2. Check `~/.local/share/opencode/log/debug.log`.
3. Observe install error:
   - `No version matching "0.0.0-refactor/origin-dev-sync-202602091803" found for specifier "@opencode-ai/plugin"`

## Root Cause

- Two runtime dependency manifests had an invalid pinned version:
  - `~/.config/opencode/package.json`
  - `~/.local/share/opencode/package.json`
- Both referenced a non-published preview tag for `@opencode-ai/plugin`.
- Startup bootstrap triggers `opencode install`, which failed resolving that version.

## Fix Applied

- Updated both local manifests to a valid version:
  - `@opencode-ai/plugin: "1.1.53"`
- Re-ran install in both directories:
  - `bun install` in `~/.config/opencode`
  - `bun install` in `~/.local/share/opencode`
- Install now completes without version-resolution errors.

## Verification

- `bun install` succeeded in both runtime directories.
- Invalid version string no longer present in current local package manifests.

## Follow-up

- Add a bootstrap guard to auto-heal unsupported plugin version pins in runtime manifests.
- Add warning telemetry when runtime manifest version differs from `templates/package.json` expected baseline.
