#!/bin/bash
set -euo pipefail

# 定義路徑
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE_DIR="$PROJECT_ROOT/templates"
USER_CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"

echo "[Dev Sync] Checking for configuration updates..."

# 確保目標目錄存在
mkdir -p "$USER_CONFIG_DIR/skills"

# Check for rsync
if ! command -v rsync &> /dev/null; then
    echo "Error: rsync is required but not installed."
    exit 1
fi

# ---------------------------------------------------------
# 1. System Prompt (AGENTS.md) - Update only if newer
# ---------------------------------------------------------
if [ -f "$TEMPLATE_DIR/AGENTS.md" ]; then
    # -u: update only (don't overwrite newer user file)
    rsync -ut "$TEMPLATE_DIR/AGENTS.md" "$USER_CONFIG_DIR/AGENTS.md"
    echo "  -> Synced: AGENTS.md"
fi

# ---------------------------------------------------------
# 2. Core Skills - Update only if newer
# ---------------------------------------------------------
# 只同步核心開發相關的 skill，避免覆蓋使用者自定義的其他 skill
CORE_SKILLS=("agent-workflow" "model-selector")

for SKILL in "${CORE_SKILLS[@]}"; do
    SRC_DIR="$TEMPLATE_DIR/skills/$SKILL"
    DEST_DIR="$USER_CONFIG_DIR/skills/$SKILL"
    
    if [ -d "$SRC_DIR" ]; then
        mkdir -p "$DEST_DIR"
        # -a: archive
        # -u: update only (Latest Wins)
        # --delete: mirror (ensure clean state)
        rsync -au --delete "$SRC_DIR/" "$DEST_DIR/"
        echo "  -> Synced: Skill '$SKILL'"
    fi
done

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
