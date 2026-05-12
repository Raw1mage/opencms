#!/bin/bash
set -e

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}🚀 OpenCode Fresh Setup Utility${NC}"
echo "=================================="

# 1. Check & Install OpenCode CLI
echo -e "\n${GREEN}[1/5] Checking OpenCode CLI...${NC}"
if ! command -v opencode &> /dev/null; then
    echo "Installing OpenCode CLI..."
    npm install -g opencode
else
    echo "OpenCode CLI is already installed."
fi

# 2. Setup Configuration Directory & Plugins
CONFIG_DIR="$HOME/.config/opencode"
echo -e "\n${GREEN}[2/5] Setting up ~/.config/opencode...${NC}"

mkdir -p "$CONFIG_DIR"
cd "$CONFIG_DIR"

if [ ! -f "package.json" ]; then
    echo "Initializing npm project..."
    npm init -y > /dev/null
fi

# 3. Create opencode.json
echo -e "\n${GREEN}[3/5] Configuring opencode.json...${NC}"
cat > "$CONFIG_DIR/opencode.json" <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
  "provider": {
    "google": {
      "models": {
        "gemini-2.5-flash": { "name": "Gemini 2.5 Flash (Free Tier)" },
        "gemini-2.5-pro": { "name": "Gemini 2.5 Pro (Free Tier)" }
      }
    }
  }
}
EOF
echo "Created opencode.json with canonical Google provider configuration."

# 4. Setup API Key
echo -e "\n${GREEN}[4/5] Setting up Google API Key (Free Tier)...${NC}"
if grep -q "GOOGLE_API_KEY" "$HOME/.bashrc"; then
    echo "GOOGLE_API_KEY is already set in ~/.bashrc."
else
    read -p "Enter your Google AI Studio API Key (starts with AIza...): " API_KEY
    if [ ! -z "$API_KEY" ]; then
        echo "" >> "$HOME/.bashrc"
        echo "# OpenCode Google AI Studio Key" >> "$HOME/.bashrc"
        echo "export GOOGLE_API_KEY=$API_KEY" >> "$HOME/.bashrc"
        echo "API Key added to ~/.bashrc"
    else
        echo "Skipping API Key setup (you can add it later to ~/.bashrc)."
    fi
fi

# 5. Setup Skills Directory
echo -e "\n${GREEN}[5/5] Setting up Skills...${NC}"
SKILLS_DIR="$HOME/projects/skills"
mkdir -p "$SKILLS_DIR"
echo "Skills directory created at $SKILLS_DIR"

echo -e "\n${BLUE}✅ Setup Complete!${NC}"
echo "Please restart your shell or run: source ~/.bashrc"
echo "Then try: opencode run -m google/gemini-2.5-flash 'Hello'"
