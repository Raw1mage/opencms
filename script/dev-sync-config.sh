#!/bin/bash

# 定義路徑
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE_DIR="$PROJECT_ROOT/templates"
USER_CONFIG_DIR="$HOME/.config/opencode"

echo "[Dev Sync] Checking for configuration updates..."

# 確保目標目錄存在
mkdir -p "$USER_CONFIG_DIR/skills"

# ---------------------------------------------------------
# 1. System Prompt (AGENTS.md) - Update only if newer
# ---------------------------------------------------------
if [ -f "$TEMPLATE_DIR/AGENTS.md" ]; then
    if [ ! -f "$USER_CONFIG_DIR/AGENTS.md" ] || [ "$TEMPLATE_DIR/AGENTS.md" -nt "$USER_CONFIG_DIR/AGENTS.md" ]; then
        cp "$TEMPLATE_DIR/AGENTS.md" "$USER_CONFIG_DIR/AGENTS.md"
        echo "  -> Updated: AGENTS.md (Newer version found)"
    else
        echo "  -> Skipped: AGENTS.md (User version is current)"
    fi
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
        # 如果目標不存在，直接複製
        if [ ! -d "$DEST_DIR" ]; then
            cp -r "$SRC_DIR" "$DEST_DIR"
            echo "  -> Installed: Skill '$SKILL'"
            continue
        fi

        # 如果目標存在，檢查 SKILL.md 是否更新
        # 這裡簡化邏輯：只檢查 SKILL.md 的時間戳，因為它是 Skill 的核心定義
        if [ "$SRC_DIR/SKILL.md" -nt "$DEST_DIR/SKILL.md" ]; then
            # 移除舊版並複製新版 (確保目錄結構一致)
            rm -rf "$DEST_DIR"
            cp -r "$SRC_DIR" "$DEST_DIR"
            echo "  -> Updated: Skill '$SKILL' (Newer version found)"
        else
             echo "  -> Skipped: Skill '$SKILL' (User version is current)"
        fi
    fi
done

# ---------------------------------------------------------
# 3. User Data - Install only if missing (NEVER OVERWRITE)
# ---------------------------------------------------------
USER_FILES=("accounts.json" "opencode.json")

for FILE in "${USER_FILES[@]}"; do
    if [ ! -f "$USER_CONFIG_DIR/$FILE" ] && [ -f "$TEMPLATE_DIR/$FILE" ]; then
        cp "$TEMPLATE_DIR/$FILE" "$USER_CONFIG_DIR/$FILE"
        echo "  -> Initialized: $FILE (Missing file created)"
    fi
done

echo "[Dev Sync] Ready. Starting Opencode..."
