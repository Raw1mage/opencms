# Observability

## Manual UI checks

- Embedded stream shows a single continuous canvas.
- User/assistant/tool/error content appears as card-like entries.
- Thinking/compaction/running-tool progress appears only on the turn status line.

## Automated checks

- Focused app typecheck.
- Focused browser builds for touched frontend entry files.
- `git diff --check`.

## No new telemetry

This plan does not add runtime telemetry. Backend/session logs remain the authority for execution debugging.
