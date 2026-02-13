#!/bin/bash
set -euo pipefail

# 定義路徑
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE_DIR="$PROJECT_ROOT/templates"
USER_CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"

echo "[Dev Sync Back] Synchronizing User Config -> Project Templates..."
echo "Source: $USER_CONFIG_DIR"
echo "Target: $TEMPLATE_DIR"

# Check for rsync
if ! command -v rsync &> /dev/null; then
    echo "Error: rsync is required but not installed."
    exit 1
fi

# 1. 反向同步 System Prompt (AGENTS.md)
if [ -f "$USER_CONFIG_DIR/AGENTS.md" ]; then
    # -u: update (skip if dest is newer)
    # -t: preserve times
    rsync -ut "$USER_CONFIG_DIR/AGENTS.md" "$TEMPLATE_DIR/AGENTS.md"
    echo "  -> Synced: templates/AGENTS.md"
fi

# 2. 反向同步 Core Skills
# 只同步核心開發相關的 skill，避免污染 Repo
CORE_SKILLS=("agent-workflow" "model-selector")

for SKILL in "${CORE_SKILLS[@]}"; do
    SRC="$USER_CONFIG_DIR/skills/$SKILL"
    DEST="$TEMPLATE_DIR/skills/$SKILL"
    
    if [ -d "$SRC" ]; then
        mkdir -p "$DEST"
        # -a: archive
        # -v: verbose
        # -u: update only (Latest Wins)
        # --delete: mirror source (remove extraneous files in dest)
        rsync -avu --delete "$SRC/" "$DEST/"
        echo "  -> Synced: templates/skills/$SKILL"
    else
        echo "  -> Warning: User skill '$SKILL' not found in config."
    fi
done

echo "[Dev Sync Back] Complete."
