---
name: mcp-finder
description: Search for, install, and configure Model Context Protocol (MCP) servers from the open-source community to dynamically extend agent capabilities.
---

# MCP Finder

This skill enables the agent (Antigravity/OpenCode) to autonomously find, download, and install MCP servers, seamlessly giving itself new tools and resources without requiring manual developer intervention.

## Philosophy

The goal is to make OpenCode a "self-growing organism." If you realize you lack the capability to fulfill a user's request (e.g., "Summarize my latest Slack messages" or "Query my Postgres database"), you should trigger this workflow to automatically acquire the necessary MCP server.

## Workflow

When the user asks to "find an MCP" or "install an MCP" for a specific task, OR when you autonomously recognize a missing capability that an MCP server could solve, follow these steps:

### 1. Discovery & Search
Search for an appropriate MCP server online.
*   **Search Strategy 1**: Search the official MCP registry or NPM.
    *   Query: `"@modelcontextprotocol/server-<topic>"` or `"mcp-server-<topic>"`
*   **Search Strategy 2**: Search GitHub for open-source implementations.
    *   Query: `site:github.com "mcp server" OR "Model Context Protocol" <topic>`

### 2. Evaluate the Server
Review the repository or NPM package documentation (`README.md`).
*   Verify that it is an actual MCP server implementation.
*   Identify the execution method: Does it run via `npx` (Node.js), `uvx` (Python), or a downloaded binary?
*   Identify required environment variables (e.g., API keys, database URLs, auth tokens).

### 3. Configure the MCP Server
Modify the user's global MCP configuration file: `~/.config/opencode/opencode.json` (or the project-specific `opencode.json` if requested).

*   Use the `view_file` tool to read the current configuration.
*   Use the `replace_file_content` or `multi_replace_file_content` tool to carefully inject the new server into the `"mcp"` key.

**Configuration Template Example:**
```json
"mcp": {
  ...existing servers...
  "new-mcp-name": {
    "type": "local",
    "command": ["npx", "-y", "@modelcontextprotocol/server-example"],
    "environment": {
      "EXAMPLE_API_KEY": "YOUR_API_KEY_HERE"
    },
    "enabled": true
  }
}
```

### 4. User Prompting for Secrets (Crucial Step)
If the MCP server requires personal credentials (like API keys, tokens, or passwords):
*   **NEVER** guess or hallucinate these values.
*   Leave placeholder strings in the `opencode.json` file (e.g., `"YOUR_SLACK_TOKEN_HERE"`).
*   Stop and explicitly inform the user exactly what they need to do:
    *   Tell them *where* the config file is located (`~/.config/opencode/opencode.json`).
    *   Tell them *which* environment variables need to be filled in.
    *   Provide them a link to where they can obtain those keys (if available in the documentation).

### 5. Verification
Read the configured tools and prompt the user to restart the agent (or reload the window) so the new MCP capabilities become active. Explain what new tools will be available once the configuration is finalized.
