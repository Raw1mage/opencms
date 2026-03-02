# Event: source /etc/opencode/opencode.env from repo template

Date: 2026-03-02
Status: Done

## Requirement

- `/etc/opencode/opencode.env` must be created from a repo template file under `templates/` during install flow.

## Changes

1. Added template file:
   - `templates/system/opencode.env`
2. Updated `install.sh` (`--system-init` flow):
   - env file creation now copies from `templates/system/opencode.env`
   - if template is missing, installer exits with explicit error
   - existing `/etc/opencode/opencode.env` still remains preserved (no overwrite)

## Result

- System env defaults now have a single source in repo templates.
- Installer behavior is deterministic and reviewable through template diffs.
