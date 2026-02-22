# Event: Test governance update - retire obsolete tests

- **Date**: 2026-02-21
- **Status**: Done
- **Scope**: `docs/ARCHITECTURE.md`

## Decision

Added a normative testing governance rule for `cms`:

1. Tests that validate intentionally removed legacy behavior should be retired (delete or legacy-gate), not force-fixed.
2. Test maintenance must separate true regression detection from obsolete contract assertions.

## Documentation Change

- Added chapter:
  - `## 18. Test Governance Rule: Retire Obsolete Tests (Normative)`
- Includes:
  - retirement criteria,
  - allowed actions (delete / legacy-gate / rewrite),
  - PR requirements for traceability.

## Expected Impact

- Reduce false-fail noise in CI.
- Improve confidence that remaining test failures represent real regressions or active contracts.
