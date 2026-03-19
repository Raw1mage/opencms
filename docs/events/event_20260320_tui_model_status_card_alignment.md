# Event: TUI model status card alignment

**Date**: 2026-03-20
**Branch**: `main`

## Need

- Align TUI sidebar monitoring surface with webapp by surfacing the same model status card that ships in the web status sidebar.

## Scope

### IN

- TUI sidebar rendering code in `packages/opencode/src/cli/cmd/tui/routes/session/sidebar.tsx`.
- Reuse existing sync/context data (monitor entries, local model, llm history) to show model status.
- Documentation update with this event entry plus verification notes.

### OUT

- Webapp features beyond the existing status card (no API or backend changes).
- Non-TUI interfaces (desktop app, CLI non-sidebar).

## Task Checklist

- [x] Record requirement, scope, and task plan (this file).
- [ ] Audit webapp model status card implementation to identify data/behavior to reuse in TUI.
- [ ] Implement card in TUI sidebar with alignment to web behavior and data sources.
- [ ] Validate via TUI build/test and document verification results plus architecture sync note.

## Key Decisions

- Use the existing TUI sync store (monitor entries + llm history) instead of calling new APIs.
- Limit card to sidebar context (no new routes or popovers).

## Verification

- `bunx tsc --noEmit packages/opencode` (or equivalent) once implementation complete.
- Manual smoke test by launching TUI/sidebar locally (TODO).

* Architecture Sync: `specs/architecture.md` (note if no changes are needed, record verification as "Architecture Sync: Verified (No doc changes)").
