#!/bin/bash
set -euo pipefail

# 定義路徑
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE_DIR="$PROJECT_ROOT/templates"
USER_CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"

echo "[Dev Sync] Syncing templates -> runtime (newer wins)..."

# 確保目標目錄存在
mkdir -p "$USER_CONFIG_DIR/skills"
mkdir -p "$USER_CONFIG_DIR/prompts"

# Check for rsync
if ! command -v rsync &> /dev/null; then
    echo "Error: rsync is required but not installed."
    exit 1
fi

# ---------------------------------------------------------
# 1. System Prompts / Agent Prompts (update only if newer)
# ---------------------------------------------------------
if [ -f "$TEMPLATE_DIR/AGENTS.md" ]; then
    # -u: newer wins (don't overwrite newer runtime file)
    rsync -ut "$TEMPLATE_DIR/AGENTS.md" "$USER_CONFIG_DIR/AGENTS.md"
    echo "  -> Synced: AGENTS.md"
fi

if [ -d "$TEMPLATE_DIR/prompts" ]; then
    mkdir -p "$USER_CONFIG_DIR/prompts"
    rsync -au "$TEMPLATE_DIR/prompts/" "$USER_CONFIG_DIR/prompts/"
    echo "  -> Synced: prompts/"
fi

# ---------------------------------------------------------
# 2. Skills (ALL skills, update only if newer)
# ---------------------------------------------------------
if [ -d "$TEMPLATE_DIR/skills" ]; then
    mkdir -p "$USER_CONFIG_DIR/skills"
    # -a: archive
    # -u: update only (newer wins)
    # no --delete: preserve locally-added skills for reverse sync
    rsync -au "$TEMPLATE_DIR/skills/" "$USER_CONFIG_DIR/skills/"
    echo "  -> Synced: skills/"
fi

# ---------------------------------------------------------
# 3. User Data - Install only if missing (NEVER OVERWRITE)
# ---------------------------------------------------------
USER_FILES=("accounts.json" "opencode.json")

for FILE in "${USER_FILES[@]}"; do
    if [ -f "$TEMPLATE_DIR/$FILE" ]; then
        # --ignore-existing: do not overwrite existing files
        rsync -a --ignore-existing "$TEMPLATE_DIR/$FILE" "$USER_CONFIG_DIR/$FILE"
        echo "  -> Checked: $FILE"
    fi
done

echo "[Dev Sync] Ready. Starting Opencode..."
