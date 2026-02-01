#!/bin/bash
# =============================================================================
# Opencode Config Sync Script
# =============================================================================
# Syncs all opencode configuration files from user's home directory to
# ./config/ for Docker deployment.
#
# Usage: ./scripts/sync-config.sh
# =============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
CONFIG_DIR="$PROJECT_ROOT/config"

# Source directories
XDG_CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
XDG_DATA="${XDG_DATA_HOME:-$HOME/.local/share}/opencode"
XDG_STATE="${XDG_STATE_HOME:-$HOME/.local/state}/opencode"
OPENCODE_HOME="$HOME/.opencode"

echo "=== Opencode Config Sync ==="
echo "Project root: $PROJECT_ROOT"
echo "Config dir: $CONFIG_DIR"
echo ""

# Create target directory structure
mkdir -p "$CONFIG_DIR/opencode"   # For XDG_CONFIG_HOME/opencode
mkdir -p "$CONFIG_DIR/data"       # For XDG_DATA_HOME/opencode
mkdir -p "$CONFIG_DIR/state"      # For XDG_STATE_HOME/opencode

# -----------------------------------------------------------------------------
# 1. Sync config files from ~/.config/opencode/
# -----------------------------------------------------------------------------
echo "--- Syncing from $XDG_CONFIG ---"

# Main config file (resolve symlink if needed)
if [ -L "$XDG_CONFIG/opencode.json" ]; then
    REAL_CONFIG=$(readlink -f "$XDG_CONFIG/opencode.json")
    echo "  opencode.json (from symlink -> $REAL_CONFIG)"
    cp "$REAL_CONFIG" "$CONFIG_DIR/opencode/opencode.json"
elif [ -f "$XDG_CONFIG/opencode.json" ]; then
    echo "  opencode.json"
    cp "$XDG_CONFIG/opencode.json" "$CONFIG_DIR/opencode/opencode.json"
elif [ -f "$XDG_CONFIG/config.json" ]; then
    echo "  config.json -> opencode.json"
    cp "$XDG_CONFIG/config.json" "$CONFIG_DIR/opencode/opencode.json"
fi

# Commands directory
if [ -d "$XDG_CONFIG/commands" ]; then
    echo "  commands/"
    cp -r "$XDG_CONFIG/commands" "$CONFIG_DIR/opencode/"
fi

# Agents directory
if [ -d "$XDG_CONFIG/agents" ]; then
    echo "  agents/"
    cp -r "$XDG_CONFIG/agents" "$CONFIG_DIR/opencode/"
fi

# Skills directory (symlink or real, exclude .git)
if [ -L "$XDG_CONFIG/skills" ]; then
    REAL_SKILLS=$(readlink -f "$XDG_CONFIG/skills")
    echo "  skills/ (from symlink -> $REAL_SKILLS, excluding .git)"
    mkdir -p "$CONFIG_DIR/opencode/skills"
    rsync -a --exclude='.git' "$REAL_SKILLS/" "$CONFIG_DIR/opencode/skills/" 2>/dev/null || \
        find "$REAL_SKILLS" -mindepth 1 -maxdepth 1 ! -name '.git' -exec cp -r {} "$CONFIG_DIR/opencode/skills/" \;
elif [ -d "$XDG_CONFIG/skills" ]; then
    echo "  skills/ (excluding .git)"
    mkdir -p "$CONFIG_DIR/opencode/skills"
    rsync -a --exclude='.git' "$XDG_CONFIG/skills/" "$CONFIG_DIR/opencode/skills/" 2>/dev/null || \
        find "$XDG_CONFIG/skills" -mindepth 1 -maxdepth 1 ! -name '.git' -exec cp -r {} "$CONFIG_DIR/opencode/skills/" \;
fi

# Antigravity accounts (legacy but still used)
if [ -f "$XDG_CONFIG/antigravity-accounts.json" ]; then
    echo "  antigravity-accounts.json"
    cp "$XDG_CONFIG/antigravity-accounts.json" "$CONFIG_DIR/opencode/"
fi

# -----------------------------------------------------------------------------
# 2. Sync data files from ~/.local/share/opencode/
# -----------------------------------------------------------------------------
echo ""
echo "--- Syncing from $XDG_DATA ---"

# accounts.json (main auth storage)
if [ -f "$XDG_DATA/accounts.json" ]; then
    echo "  accounts.json"
    cp "$XDG_DATA/accounts.json" "$CONFIG_DIR/data/"
    chmod 600 "$CONFIG_DIR/data/accounts.json"
fi

# mcp-auth.json (MCP OAuth tokens)
if [ -f "$XDG_DATA/mcp-auth.json" ]; then
    echo "  mcp-auth.json"
    cp "$XDG_DATA/mcp-auth.json" "$CONFIG_DIR/data/"
    chmod 600 "$CONFIG_DIR/data/mcp-auth.json"
fi

# ignored-models.json
if [ -f "$XDG_DATA/ignored-models.json" ]; then
    echo "  ignored-models.json"
    cp "$XDG_DATA/ignored-models.json" "$CONFIG_DIR/data/"
fi

# Legacy auth.json (if still exists)
if [ -f "$XDG_DATA/auth.json" ]; then
    echo "  auth.json (legacy)"
    cp "$XDG_DATA/auth.json" "$CONFIG_DIR/data/"
    chmod 600 "$CONFIG_DIR/data/auth.json"
fi

# -----------------------------------------------------------------------------
# 3. Sync state files from ~/.local/state/opencode/
# -----------------------------------------------------------------------------
echo ""
echo "--- Syncing from $XDG_STATE ---"

# model.json (model selection preferences)
if [ -f "$XDG_STATE/model.json" ]; then
    echo "  model.json"
    cp "$XDG_STATE/model.json" "$CONFIG_DIR/state/"
fi

# model-health.json (model health tracking)
if [ -f "$XDG_STATE/model-health.json" ]; then
    echo "  model-health.json"
    cp "$XDG_STATE/model-health.json" "$CONFIG_DIR/state/"
fi

# kv.json (key-value store)
if [ -f "$XDG_STATE/kv.json" ]; then
    echo "  kv.json"
    cp "$XDG_STATE/kv.json" "$CONFIG_DIR/state/"
fi

# prompt-history.jsonl
if [ -f "$XDG_STATE/prompt-history.jsonl" ]; then
    echo "  prompt-history.jsonl"
    cp "$XDG_STATE/prompt-history.jsonl" "$CONFIG_DIR/state/"
fi

# frecency.jsonl
if [ -f "$XDG_STATE/frecency.jsonl" ]; then
    echo "  frecency.jsonl"
    cp "$XDG_STATE/frecency.jsonl" "$CONFIG_DIR/state/"
fi

# -----------------------------------------------------------------------------
# 4. Sync from ~/.opencode/ (legacy paths)
# -----------------------------------------------------------------------------
echo ""
echo "--- Syncing from $OPENCODE_HOME ---"

# openai-codex-accounts.json (legacy)
if [ -f "$OPENCODE_HOME/openai-codex-accounts.json" ]; then
    echo "  openai-codex-accounts.json (legacy)"
    cp "$OPENCODE_HOME/openai-codex-accounts.json" "$CONFIG_DIR/opencode/"
fi

# local-config bin scripts (skip large/old files)
if [ -d "$OPENCODE_HOME/local-config/bin" ]; then
    echo "  local-config/bin/ (excluding *.old, large files)"
    mkdir -p "$CONFIG_DIR/opencode/bin"
    find "$OPENCODE_HOME/local-config/bin" -maxdepth 1 -type f \
        ! -name "*.old" \
        ! -name "*.bak" \
        -size -10M \
        -exec cp {} "$CONFIG_DIR/opencode/bin/" \; 2>/dev/null || true
fi

# -----------------------------------------------------------------------------
# 5. Copy native libraries (bun-pty)
# -----------------------------------------------------------------------------
echo ""
echo "--- Copying native libraries ---"

BUNPTY_LIB="$PROJECT_ROOT/packages/opencode/node_modules/bun-pty/rust-pty/target/release"
mkdir -p "$CONFIG_DIR/lib"

if [ -f "$BUNPTY_LIB/librust_pty.so" ]; then
    echo "  librust_pty.so (x64)"
    cp "$BUNPTY_LIB/librust_pty.so" "$CONFIG_DIR/lib/"
fi

if [ -f "$BUNPTY_LIB/librust_pty_arm64.so" ]; then
    echo "  librust_pty_arm64.so (arm64)"
    cp "$BUNPTY_LIB/librust_pty_arm64.so" "$CONFIG_DIR/lib/"
fi

# -----------------------------------------------------------------------------
# 6. Sync to host volume (for Docker runtime)
# -----------------------------------------------------------------------------
echo ""
echo "--- Syncing to host volume ---"

HOST_DATA="/opt/opencode/data/opencode"
HOST_STATE="/opt/opencode/state/opencode"

if [ -d "$HOST_DATA" ]; then
    if [ -f "$CONFIG_DIR/data/accounts.json" ]; then
        echo "  accounts.json -> $HOST_DATA/"
        sudo cp "$CONFIG_DIR/data/accounts.json" "$HOST_DATA/"
        sudo chmod 600 "$HOST_DATA/accounts.json"
        sudo chown 1000:1000 "$HOST_DATA/accounts.json"
    fi
fi

if [ -d "$HOST_STATE" ]; then
    if [ -f "$CONFIG_DIR/state/model.json" ]; then
        echo "  model.json -> $HOST_STATE/"
        sudo cp "$CONFIG_DIR/state/model.json" "$HOST_STATE/"
        sudo chown 1000:1000 "$HOST_STATE/model.json"
    fi
fi

# -----------------------------------------------------------------------------
# Summary
# -----------------------------------------------------------------------------
echo ""
echo "=== Sync Complete ==="
echo ""
echo "Config directory structure:"
find "$CONFIG_DIR" -type f | sort | while read -r f; do
    size=$(stat --printf="%s" "$f" 2>/dev/null || stat -f%z "$f" 2>/dev/null)
    echo "  ${f#$CONFIG_DIR/} ($size bytes)"
done
echo ""
echo "Ready for Docker deployment. Use:"
echo "  docker-compose -f docker-compose.production.yml build"
echo "  docker-compose -f docker-compose.production.yml up -d"
