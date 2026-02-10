# OpenCode Terminal Protection
# Ensures terminal reset on unexpected exit from TUI applications
# Source this file in your .bashrc or .zshrc

# Wrap opencode to ensure terminal reset on exit
opencode() { trap reset EXIT; command opencode "$@"; trap - EXIT; }

# Wrap bun to ensure terminal reset on exit (for bun run dev, etc.)
bun() { trap reset EXIT; command bun "$@"; trap - EXIT; }
