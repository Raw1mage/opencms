#!/bin/bash

# 定義母體檔案 (Single Source of Truth)
SOURCE_FILE="$HOME/.config/opencode/AGENTS.md"

# 確保母體存在
if [ ! -f "$SOURCE_FILE" ]; then
    echo "Error: Source Constitution not found at $SOURCE_FILE"
    exit 1
fi

echo "Deploying Opencode Constitution v3.3 (Symlink Mode)..."

# 定義目標路徑清單
# 這些是不同 AI 工具通常會讀取的路徑
TARGETS=(
    "$HOME/projects/opencode/AGENTS.md"                 # 專案根目錄 (通用)
    "$HOME/projects/opencode/.cursorrules"               # Cursor IDE (強制生效)
    "$HOME/projects/opencode/.vscode/AGENTS.md"          # VS Code Context
    "$HOME/projects/opencode/.anthropic/instructions.md" # Claude CLI (常見慣例)
    "$HOME/.local/share/opencode/AGENTS.md"              # 系統備份
)

# 執行 Symlink
for TARGET in "${TARGETS[@]}"; do
    # 確保目標目錄存在
    DIR=$(dirname "$TARGET")
    mkdir -p "$DIR"

    # 如果目標是普通檔案 (非 link)，先備份
    if [ -f "$TARGET" ] && [ ! -L "$TARGET" ]; then
        echo "Backing up existing file: $TARGET"
        mv "$TARGET" "${TARGET}.bak"
    fi

    # 建立 Symlink (強制覆蓋)
    ln -sf "$SOURCE_FILE" "$TARGET"
    echo "Linked: $TARGET -> $SOURCE_FILE"
done

echo "Deployment Complete. All agents will now reference the Single Source of Truth."
