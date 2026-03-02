# Event: runtime restore after /var/lib switch regression

Date: 2026-03-02
Status: Done

## Symptom

- After system service switched to `HOME=/nonexistent` + `XDG_*=/var/lib/opencode/*`, web login worked but runtime appeared reset.
- Affected observed data: `accounts.json` and session history visibility.

## Root Cause

- Existing user data remained in `/home/pkcs12/.config|.local/.../opencode`.
- Service runtime now reads `/var/lib/opencode/.../opencode` and was initialized from templates (minimal files), so UI looked like fresh state.
- Phase 2 routing currently pilots only part of read path, so many APIs still read service-scope storage.

## Hotfix Applied

1. Stopped `opencode-web.service`.
2. Backed up current service-scope runtime to:
   - `/var/lib/opencode/migration-backup-20260302_155727`
3. Restored data from pkcs12 runtime into service scope:
   - `/home/pkcs12/.config/opencode/` -> `/var/lib/opencode/config/opencode/`
   - `/home/pkcs12/.local/share/opencode/` -> `/var/lib/opencode/data/opencode/`
   - `/home/pkcs12/.local/state/opencode/` -> `/var/lib/opencode/state/opencode/`
4. Restarted service.

## Verification

- Service active after restart.
- `/var/lib/opencode/config/opencode/accounts.json` restored (non-trivial size).
- Session directory count restored under `/var/lib/opencode/data/opencode/storage/session`.

## Note

- This is a temporary bridge until Phase 2 fully routes runtime data to authenticated user homes.
