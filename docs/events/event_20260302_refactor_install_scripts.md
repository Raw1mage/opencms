# Refactor Install Scripts

## Context

Refactoring `install.sh` to be a "Production Installer" using the compiled binary, and `webctl.sh` to be a "Development Controller" using source code.

## Changes

1.  **`install.sh`**:
    - Updated to build the backend binary (`bun run build --single`).
    - Updated systemd unit generation to use `dist/opencode-linux-x64/bin/opencode`.
    - Ensures the binary exists before service start.
2.  **`webctl.sh`**:
    - Renamed `start`/`up` to `dev-start`/`dev-up`.
    - Renamed `stop`/`down` to `dev-stop`/`dev-down`.
    - Updated help text and command routing.
