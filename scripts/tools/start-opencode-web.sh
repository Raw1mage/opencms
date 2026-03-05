#!/bin/bash

# OpenCode Web Server Startup Script
# Listens on 0.0.0.0:1080 with authentication

# Initialize environment
if [ -d "$HOME/.nvm/versions/node/v20.19.6/bin" ]; then
    export PATH="$HOME/.nvm/versions/node/v20.19.6/bin:$PATH"
fi

if [ -f "$HOME/.bashrc" ]; then
    # Source bashrc but ignore non-zero exits as it might contain interactive checks
    source "$HOME/.bashrc" || true
fi

unset OPENCODE_SERVER_USERNAME
unset OPENCODE_SERVER_PASSWORD
unset OPENCODE_SERVER_HTPASSWD
export OPENCODE_AUTH_MODE="${OPENCODE_AUTH_MODE:-pam}"
export OPENCODE_ALLOW_GLOBAL_FS_BROWSE="${OPENCODE_ALLOW_GLOBAL_FS_BROWSE:-1}"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="${PROJECT_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
cd "$PROJECT_ROOT"

# Serve CMS frontend build (with AuthGate/login) instead of proxying upstream
export OPENCODE_FRONTEND_PATH="${OPENCODE_FRONTEND_PATH:-$PROJECT_ROOT/packages/app/dist}"

echo "Starting OpenCode Web Server..."
echo "URL: http://0.0.0.0:1080"
echo "Auth mode: $OPENCODE_AUTH_MODE"
echo "Frontend: $OPENCODE_FRONTEND_PATH"
echo "Global FS browse: $OPENCODE_ALLOW_GLOBAL_FS_BROWSE"
echo ""

# @event_2026-02-06_xdg-install: resolve binary dynamically
BIN_PATH=$(which opencode 2>/dev/null || echo "/usr/local/bin/opencode")
exec "$BIN_PATH" web --hostname 0.0.0.0 --port 1080
