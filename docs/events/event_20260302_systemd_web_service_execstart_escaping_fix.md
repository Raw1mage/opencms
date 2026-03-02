# Event: fix systemd ExecStart variable escaping for web service

Date: 2026-03-02
Status: Done

## Symptom

- `opencode-web.service` kept auto-restarting with:
  - `Referenced but unset environment variable evaluates to an empty string: BUN_BIN`
  - `bun not found; set OPENCODE_BUN_BIN in /etc/opencode/opencode.env`

## Root Cause

- In unit `ExecStart`, shell variables used `${...}` directly.
- systemd pre-expanded them before `bash -lc`, causing empty substitutions.

## Repair Actions

1. Set service env file:
   - `/etc/opencode/opencode.env`
   - `OPENCODE_BUN_BIN=/home/pkcs12/.bun/bin/bun`
2. Patch unit file:
   - `/etc/systemd/system/opencode-web.service`
   - Escape shell vars using `$${...}` and `$$(...)` inside `ExecStart`.
3. Verified run-as-user bridge script behavior via dummy command path:
   - `opencode -> sudo wrapper -> betaman`
   - `whoami`, `pwd`, `HOME` all resolve to `betaman` context.

## Follow-up Repair (Auth/PAM under systemd)

- Observed login failures after switching to systemd-run service.
- Root cause in unit sandbox: `NoNewPrivileges=true` blocked setuid behavior required by `su`/PAM path.
- Additional multi-user isolation mismatch: `ProtectHome=read-only` + `ReadWritePaths=/home/opencode` prevented expected user-home write behavior.

### Unit adjustments

- `NoNewPrivileges=false`
- `ProtectHome=false`
- `ReadWritePaths=/home`

### Verification

1. `systemctl daemon-reload && systemctl restart opencode-web.service`
2. Service is `active (running)` on 1080 under user `opencode`.
3. Runtime flags confirmed:
   - `OPENCODE_RUN_AS_USER_ENABLED=1`
   - `OPENCODE_RUN_AS_USER_WRAPPER=/usr/local/libexec/opencode-run-as-user`
4. Process status confirmed `NoNewPrivs: 0`.
5. Dummy bridge chain `opencode -> sudo wrapper -> betaman` returns:
   - `whoami=betaman`
   - `pwd=/home/betaman`
   - `HOME=/home/betaman`
