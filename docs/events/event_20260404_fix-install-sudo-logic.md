# Event: Fix install.sh run_as_root logic

## Situation
- `webctl.sh install` fails when checking for non-existent systemd service files.
- Error message: `[ERR] sudo failed while running: test -f /etc/systemd/system/opencode-user@.service`.
- Cause: `run_as_root` fails on any non-zero exit code, misinterpreting `test` failure (file not found) as a `sudo` privilege escalation failure.

## Changes
- Modified `install.sh`: Refactored `run_as_root` to correctly return the exit code of the subcommand instead of exiting with an error.

## Next Step
- Commit changes to restore repo cleanliness.
- Rerun `./webctl.sh install`.
