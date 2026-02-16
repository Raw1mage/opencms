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

export OPENCODE_SERVER_USERNAME="opencode"
export OPENCODE_SERVER_PASSWORD="Ne20240Wsl!"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="${PROJECT_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
cd "$PROJECT_ROOT"

echo "Starting OpenCode Web Server..."
echo "URL: http://0.0.0.0:1080"
echo "Username: opencode"
echo ""

# @event_2026-02-06_xdg-install: resolve binary dynamically
BIN_PATH=$(which opencode 2>/dev/null || echo "/usr/local/bin/opencode")
exec "$BIN_PATH" web --hostname 0.0.0.0 --port 1080
