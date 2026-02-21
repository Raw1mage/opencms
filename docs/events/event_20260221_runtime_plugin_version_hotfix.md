# Event: Runtime plugin version hotfix for tools-call failure

- **Date**: 2026-02-21
- **Status**: Done
- **Scope**: Runtime manifests outside repo (`~/.config/opencode`, `~/.local/share/opencode`)

## Symptom

- Tools call flow failed during dependency install with:
  - `No version matching "0.0.0-cms-202602201859" found for specifier "@opencode-ai/plugin"`

## Root Cause

- Runtime manifests pinned `@opencode-ai/plugin` to a non-published version string:
  - `/home/pkcs12/.config/opencode/package.json`
  - `/home/pkcs12/.local/share/opencode/package.json`

## Fix Applied

- Updated both runtime manifests to published stable version:
  - `@opencode-ai/plugin: "1.1.53"`
- Reinstalled dependencies in both runtime directories with `bun install`.

## Validation

- `bun install` succeeded in both directories without version resolution errors.
- No further `No version matching ... @opencode-ai/plugin` observed in this repair flow.

## Next

- Plan a follow-up to decouple/validate runtime dependency pinning strategy for external libraries.
