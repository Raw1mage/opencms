# Event: install bootstrap adds Linux system service initialization

Date: 2026-03-02
Status: Done

## Decision

- Extend `install.sh` to support system-level initialization for PAM multi-user deployments.
- Default service identity is a dedicated non-login account (`opencode`) instead of coupling runtime to a personal user (e.g. `pkcs12`).

## Changes

1. `install.sh`
   - Added new flags:
     - `--system-init`
     - `--service-user <name>`
     - `--service-name <name>`
   - Added Linux system init flow:
     - create service user (system account + nologin shell)
     - initialize per-service runtime directories under `/home/<service-user>`
     - create `/etc/opencode/opencode.env` if missing
     - generate `/etc/systemd/system/<service-name>.service`
     - `systemctl daemon-reload` + `enable`, with optional immediate start
   - Added interactive recommendation prompt for Linux users to run system init.

2. `README.md`
   - Documented new installation flags and system-init behavior.
   - Added recommendation to decouple web service runtime from personal accounts.

## Rationale

- PAM authentication implies user identity isolation; shared runtime under one personal home directory is a security and operations risk.
- systemd-managed service account improves stability, observability, and lifecycle management.

## Follow-up

- Next step is execution-plane isolation: user-initiated work should run under each authenticated Linux user identity with per-user HOME/XDG runtime.
