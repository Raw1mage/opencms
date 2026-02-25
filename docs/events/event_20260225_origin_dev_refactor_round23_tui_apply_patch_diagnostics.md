# Event: origin/dev refactor round23 (TUI apply_patch diagnostics visibility)

Date: 2026-02-25
Status: Done

## Round goal

Expose LSP diagnostics for `apply_patch` tool output and remove duplicated diagnostics rendering logic across TUI tool blocks.

## Candidate & assessment

- Candidate: `637059a515a6afd983a8a615f90650d997a821ce`
- Decision: **Port**
- Rationale:
  - High practical value for debugging patch failures in TUI.
  - Low architectural risk (presentation-layer refactor within existing tool-render route).

## Rewrite-only port in cms

- `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx`
  - Added shared `Diagnostics` renderer component.
  - Replaced duplicated diagnostics blocks in `Write` and `Edit` tool views.
  - Added diagnostics output to `ApplyPatch` file diff view (for move/patch targets).

## Validation

- `bun run packages/opencode/src/index.ts admin --help` ✅
- `bun test packages/opencode/test/cli/output-filtering.test.ts --timeout 20000` ✅

## Architecture gate

- Checked `docs/ARCHITECTURE.md` before commit.
- Result: **No architecture doc update required** (UI presentation-layer consolidation within existing TUI/tool boundaries).
