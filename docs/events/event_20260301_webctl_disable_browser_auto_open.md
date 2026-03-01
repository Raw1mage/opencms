# Event: disable browser auto-open in managed webctl start/restart

Date: 2026-03-01
Status: Done

## Symptom

- In reverse-proxy deployment (`crm.sob.com.tw`), restart could trigger browser navigation/open behavior to `http://localhost:1080/...`.

## Root Cause

- `web` command auto-opens browser URLs by default.
- `webctl.sh` starts web server with `--hostname 0.0.0.0`, and command output path uses localhost for local access display/open.

## Changes

1. `packages/opencode/src/cli/cmd/web.ts`
   - Added env guard `OPENCODE_WEB_NO_OPEN`.
   - When set, skip automatic `open(...)` behavior.

2. `webctl.sh`
   - `do_start` now exports `OPENCODE_WEB_NO_OPEN=1` for both source and standalone modes.

3. `README.md`
   - Added note that managed `webctl.sh` startup does not auto-open browser tabs.

## Expected Outcome

- Restart no longer triggers browser-side localhost tab/navigation side effects in managed deployment flows.
