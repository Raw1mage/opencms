# Event: system service no-home refactor (phase 1)

Date: 2026-03-02
Status: Done

## Goal

- Remove dependency on `/home/opencode` for system service runtime.
- Keep service account in a `nobody`-style posture (non-login, no real home).
- Install/execute Bun from `/usr/local` path.

## Changes

1. `install.sh` (`--system-init`) updated:
   - Service user creation switched to no-home mode:
     - `useradd --system --no-create-home --home-dir /nonexistent --shell nologin`
   - Existing service user is normalized via `usermod` to `/nonexistent` + `nologin`.
   - Runtime directory moved from `/home/<service-user>` to `/var/lib/opencode`.
   - Env template now suggests `OPENCODE_BUN_BIN=/usr/local/bin/bun`.
   - Generated systemd unit no longer sets any `/home/<service-user>` XDG paths.
   - Generated unit now uses:
     - `HOME=/nonexistent`
     - `OPENCODE_DATA_HOME=/var/lib/opencode`
     - `XDG_*=/var/lib/opencode/{config,data,state,cache}`
   - Sandbox settings aligned with PAM bridge requirements:
     - `NoNewPrivileges=false`
     - `ProtectHome=false`
     - `ReadWritePaths=/home /var/lib/opencode`

2. Live host service updated accordingly:
   - `/etc/systemd/system/opencode-web.service` patched to remove `/home/opencode` references.
   - `/etc/opencode/opencode.env` set `OPENCODE_BUN_BIN=/usr/local/bin/bun`.
   - `opencode` account set to `/nonexistent` and `nologin`.

## Verification

- `opencode-web.service` is active and listening on `:1080`.
- Service runtime environment confirms:
  - `HOME=/nonexistent`
  - `OPENCODE_BUN_BIN=/usr/local/bin/bun`
  - `XDG_*=/var/lib/opencode/*`
- No remaining `/home/opencode` references in `install.sh` or live unit file.

## Note

- This phase removes `/home/opencode` coupling only.
- Session/config data isolation by authenticated login user home remains a separate architecture task (phase 2).
