#!/bin/bash

# OpenCode Web Server Startup Script
# Listens on 0.0.0.0:1080 with authentication

# Initialize environment
export PATH="/home/pkcs12/.nvm/versions/node/v20.19.6/bin:$PATH"

if [ -f "/home/pkcs12/.bashrc" ]; then
    # Source bashrc but ignore non-zero exits as it might contain interactive checks
    source "/home/pkcs12/.bashrc" || true
fi

export OPENCODE_SERVER_USERNAME="opencode"
export OPENCODE_SERVER_PASSWORD="Ne20240Wsl!"

cd /home/pkcs12/opencode

echo "Starting OpenCode Web Server..."
echo "URL: http://0.0.0.0:1080"
echo "Username: opencode"
echo ""

# @event_2026-02-06_xdg-install: resolve binary dynamically
BIN_PATH=$(which opencode 2>/dev/null || echo "/usr/local/bin/opencode")
exec "$BIN_PATH" web --hostname 0.0.0.0 --port 1080
