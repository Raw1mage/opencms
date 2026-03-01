# Event: harden webctl restart and public URL output

Date: 2026-03-01
Status: Done

## Background

- `webctl.sh restart` could fail when invoked from a shell/session backed by the same web server process being restarted.
- CLI output always printed `http://localhost:<port>`, which is misleading when users access through external domain/reverse proxy.

## Changes

1. `webctl.sh restart` now defaults to **detached worker mode**:
   - Spawns `webctl.sh _restart-worker` via `nohup`.
   - Worker performs stop -> start sequence.
   - Avoids mid-command interruption in caller session.
   - Added optional `--inline` mode to preserve previous direct restart behavior.

2. Added `OPENCODE_PUBLIC_URL` support:
   - New `DISPLAY_URL` variable.
   - `start` and `status` now print `DISPLAY_URL` instead of hardcoded localhost.

3. Wiring updates:
   - Added internal command `_restart-worker` to owner-scoped command list and command dispatch.
   - Updated help text to document `OPENCODE_PUBLIC_URL`.

## Expected Outcome

- Restart is robust even when initiated from web-backed sessions.
- Reported URL matches deployment-facing access URL when configured.
