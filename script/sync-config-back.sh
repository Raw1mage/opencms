#!/bin/bash
set -euo pipefail

# 定義路徑
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE_DIR="$PROJECT_ROOT/templates"
USER_CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
USER_HOME="${HOME}"

is_safe_runtime_dir() {
    local candidate="$1"
    if [ ! -e "$candidate" ]; then
        return 0
    fi
    local resolved
    resolved="$(readlink -f "$candidate")"
    case "$resolved" in
        "$USER_HOME"/*) return 0 ;;
        *) return 1 ;;
    esac
}

echo "[Dev Sync Back] Synchronizing runtime -> templates (newer wins)..."
echo "Source: $USER_CONFIG_DIR"
echo "Target: $TEMPLATE_DIR"

# Check for rsync
if ! command -v rsync &> /dev/null; then
    echo "Error: rsync is required but not installed."
    exit 1
fi

# 1. 反向同步 System Prompts / Agent Prompts (newer wins)
if [ -f "$USER_CONFIG_DIR/AGENTS.md" ]; then
    # -u: update (skip if dest is newer)
    # -t: preserve times
    rsync -ru --no-perms --no-owner --no-group "$USER_CONFIG_DIR/AGENTS.md" "$TEMPLATE_DIR/AGENTS.md"
    echo "  -> Synced: templates/AGENTS.md"
fi

if [ -d "$USER_CONFIG_DIR/prompts" ]; then
    mkdir -p "$TEMPLATE_DIR/prompts"
    rsync -ru --no-perms --no-owner --no-group "$USER_CONFIG_DIR/prompts/" "$TEMPLATE_DIR/prompts/"
    echo "  -> Synced: templates/prompts/"
fi

# 2. 反向同步 Skills (ALL, newer wins)
# Excludes: planner/ — retired skill, superseded by plan-builder. Local
# ghost copies in user dirs must not resurrect the template after deletion.
if [ -d "$USER_CONFIG_DIR/skills" ]; then
    if is_safe_runtime_dir "$USER_CONFIG_DIR/skills"; then
        mkdir -p "$TEMPLATE_DIR/skills"
        rsync -ru --no-perms --no-owner --no-group \
            --exclude='planner/' --exclude='planner/**' \
            "$USER_CONFIG_DIR/skills/" "$TEMPLATE_DIR/skills/"
        echo "  -> Synced: templates/skills/ (excluded retired planner/)"
    else
        echo "  -> Skipped: templates/skills/ (runtime skills path resolves outside $USER_HOME)"
    fi
fi

echo "[Dev Sync Back] Complete."
