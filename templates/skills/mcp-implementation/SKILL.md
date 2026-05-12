---
name: mcp-implementation
description: MCP app implementation spec for OpenCode — covers industry-standard config formats (stdio/HTTP), zero-config import, manifest conventions, and how they map to OpenCode's McpAppManifest + ManagedAppRegistry. Use when developing new MCP apps, designing import flows, or reviewing MCP integration code.
license: Internal
---

# MCP App Implementation Spec

This skill defines the **external interoperability formats** that OpenCode's MCP app system must support, and how they map to our internal schemas.

---

## 1. Industry Standard: Claude Desktop Config Format

The de facto standard used by Claude Desktop, Cursor, VS Code Copilot, Windsurf, and virtually every MCP client.

Every MCP server README provides config in this format:

```json
{
  "mcpServers": {
    "<server-name>": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"],
      "env": { "API_KEY": "..." }
    }
  }
}
```

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `command` | `string` | Yes | Executable to launch (`npx`, `uvx`, `node`, `python`, `docker`) |
| `args` | `string[]` | Yes | Arguments passed to command |
| `env` | `Record<string, string>` | No | Environment variables injected into the process |

### Common command patterns

| Pattern | Example |
|---------|---------|
| npx (Node) | `"command": "npx", "args": ["-y", "@pkg/server"]` |
| uvx (Python) | `"command": "uvx", "args": ["mcp-server-sqlite"]` |
| docker | `"command": "docker", "args": ["run", "-i", "--rm", "image"]` |
| direct binary | `"command": "/usr/local/bin/mcp-server"` |

### Transport: **stdio only**

This config format always implies stdio transport — the client launches the process and communicates via stdin/stdout.

---

## 2. Remote Server: Streamable HTTP

For remote (hosted) MCP servers, the only config needed is a URL:

```
https://server.example.com/mcp
```

The MCP spec (2025-03-26) defines **Streamable HTTP** as the standard remote transport, replacing the deprecated HTTP+SSE:

- Client sends JSON-RPC via `POST` to the MCP endpoint
- Server responds with `application/json` or `text/event-stream` (SSE)
- Session management via `Mcp-Session-Id` header
- Optional resumability via SSE event IDs

### Backwards compatibility detection

Clients wanting to support old SSE servers:
1. POST `InitializeRequest` to URL
2. If succeeds → Streamable HTTP
3. If 4xx → GET the URL, expect SSE stream with `endpoint` event → old HTTP+SSE

---

## 3. Smithery Deep Link Protocol

Smithery (largest MCP marketplace) uses URL deep links for zero-config install:

```
{clientScheme}://deeplink-handler/mcp/install?name={displayName}&config={urlEncodedJSON}
```

Config payload is one of:

```json
// stdio
{ "type": "stdio", "command": "npx", "args": ["-y", "@smithery/cli@latest", "run", "server-name"] }

// http
{ "type": "http", "url": "https://server.example.com/mcp" }
```

### Smithery Proxy Pattern

Many remote servers are accessed via a local stdio proxy:
```
npx @smithery/cli run <server-name>
```
This converts a remote server into a local stdio process — useful for auth delegation.

---

## 4. Well-Known Server Card (Server Self-Description)

Remote servers MAY serve metadata at `/.well-known/mcp/server-card.json`:

```json
{
  "serverInfo": { "name": "My Server", "version": "1.0.0" },
  "authentication": { ... },
  "tools": [...],
  "resources": [...],
  "prompts": [...]
}
```

This is optional and not widely adopted yet.

---

## 5. Mapping to OpenCode Internal Schemas

### McpAppManifest (`mcp.json`) — Layer 1

Our `McpAppManifest.Schema` maps naturally from the external format:

| External | OpenCode `mcp.json` | Notes |
|----------|---------------------|-------|
| `command` + `args` | `command: string[]` | We merge into single array: `["npx", "-y", "@pkg/server"]` |
| `env` | `env: Record<string, string>` | Direct mapping |
| `<server-name>` | `id` + `name` | External name becomes both |
| _(none)_ | `auth` | OpenCode extension: `oauth` / `api-key` / `none` |
| _(none)_ | `source` | OpenCode extension: `github` / `local` provenance |

### ManagedAppRegistry — Layer 2

The richer `CatalogEntry` adds runtime capabilities (tools, auth bindings, config contracts) that are discovered **at runtime via MCP protocol**, not from the import config.

### Practical Reality: Fork + Adapt

There is no universal auto-import formula. External MCP servers vary wildly in build systems, auth mechanisms, env requirements, and runtime dependencies. The practical workflow is:

1. Fork the external repo into our control
2. Adapt it to our `mcp.json` convention (see checklist below)
3. Deploy to `/opt/opencode-apps/<id>/`
4. Register in `mcp-apps.json`

The external format analysis above serves as **reference knowledge** for understanding what the upstream provides, so we can efficiently adapt it.

---

## 6. Fork Adaptation Checklist

When forking an external MCP server for OpenCode use, follow this checklist:

### 6.1 Recon (before forking)

- [ ] Read the README — identify: install method, config format, required env vars, auth type
- [ ] Check if published to npm/PyPI — if yes, note the package name (may simplify command)
- [ ] Identify the transport: stdio (command-based) or HTTP (URL-based)
- [ ] Identify dependencies: Node? Python? Docker? Browser automation?
- [ ] Identify auth: API key? OAuth? None?

### 6.2 Fork & Build

- [ ] Fork repo (or copy relevant source) into our managed location
- [ ] Install dependencies (`bun install` / `pip install -r requirements.txt`)
- [ ] Build if needed (`bun run build` / `npm run build`)
- [ ] Verify the server binary/entrypoint runs: `node dist/index.js` or `python server.py`

### 6.3 Create `mcp.json`

Write the manifest following `McpAppManifest.Schema`:

```json
{
  "id": "minimax-mcp",
  "name": "MiniMax MCP",
  "command": ["node", "dist/index.js"],
  "description": "MiniMax AI capabilities (TTS, image gen, video gen)",
  "version": "1.0.0",
  "env": {
    "MINIMAX_API_KEY": "",
    "MINIMAX_API_HOST": "https://api.minimax.io"
  },
  "auth": {
    "type": "api-key",
    "provider": "minimax",
    "tokenEnv": "MINIMAX_API_KEY"
  },
  "source": {
    "type": "github",
    "repo": "MiniMax-AI/MiniMax-MCP"
  }
}
```

Key mapping decisions:

| Upstream field | Our `mcp.json` field | How to decide |
|----------------|----------------------|---------------|
| `"command": "npx"` + `"args": [...]` | `"command": ["npx", "-y", "@pkg/server"]` | Merge into single array |
| `"command": "uvx"` + `"args": [...]` | `"command": ["uvx", "pkg-name"]` | Same pattern |
| `"command": "node"` + `"args": ["dist/index.js"]` | `"command": ["node", "dist/index.js"]` | For source-built servers |
| `"env": { "API_KEY": "..." }` | `"env"` + `"auth"` | Split: secrets go to `auth`, static values go to `env` |
| _(no auth)_ | `"auth": { "type": "none" }` | Default |
| OAuth required | `"auth": { "type": "oauth", "provider": "...", "tokenEnv": "...", "scopes": [...] }` | Map to our OAuth flow |
| API key required | `"auth": { "type": "api-key", "provider": "...", "tokenEnv": "..." }` | Settings Schema (Step 4.3) handles user input |

### 6.4 Probe & Register

- [ ] `spawn` the command → MCP Client connect → `tools/list` — verify tools are discovered
- [ ] If auth required: inject test credentials via env, confirm tool calls work
- [ ] Register in `mcp-apps.json` (system or user level)
- [ ] Verify tool appears in session tool pool with `<app-id>_<tool-name>` prefix

### 6.5 Upstream Tracking

- [ ] Record upstream repo + commit hash in `source` field
- [ ] Note any patches we applied (in commit messages or a PATCHES.md in the app dir)
- [ ] When upstream updates: diff, assess, re-adapt — never blind merge

---

## 7. Design Rules

1. **No universal auto-import** — every external MCP server needs manual fork + adaptation
2. **`mcp.json` is the single contract** — once adapted, the rest of our pipeline (launch, register, UI) works automatically
3. **Tool discovery is runtime, not config** — never require users to declare tools upfront; use MCP `tools/list` after connection
4. **No silent fallback** (AGENTS.md rule) — if a server fails to start or connect, surface the error immediately
5. **Secrets go through auth/config, not hardcoded env** — user-facing secrets must flow through Settings Schema (Step 4.3) or Auth flow (Step 4.4)
6. **Prefer package manager command over clone when possible** — `npx`/`uvx` avoids managing source code; only clone when the package isn't published or needs patching
