# MCP Wire Datasheet

Per-message field reference for the MCP transports OpenCMS speaks. Per
miatdiagram §4.4: any subsystem touching wire-level packets must carry
a datasheet. MCP touches three transports plus one OpenCMS-specific
extension (`structuredContent.bundle_tar_b64`).

All transports below carry **JSON-RPC 2.0** ([spec](https://www.jsonrpc.org/specification))
as defined by the [Model Context Protocol](https://modelcontextprotocol.io/).
Method semantics here cover only what OpenCMS sends or receives in
production; full MCP method coverage lives upstream.

---

## Transport 1: stdio (JSON-RPC over child-process pipes)

**Selector**: `entry.transport === "stdio"` (default in `mcp-apps.json`)
**Connector**: `MCP.add({type: "local", command, env})` →
`StdioClientTransport` from `@modelcontextprotocol/sdk`.
**Source**: `packages/opencode/src/mcp/index.ts` lazy-connect path
(~L820 `serverApps()`, transport routing in `connectMcpApps`).

Frame format: **one JSON-RPC object per line** on `stdout` (server →
client) and `stdin` (client → server). UTF-8. No length prefix.
Server `stderr` is captured by the daemon for log correlation but is
not part of the protocol.

| Field | Type / Encoding | Required | Source (file:line) | Stability | Notes |
|---|---|---|---|---|---|
| `jsonrpc` | string `"2.0"` | required | per JSON-RPC 2.0 | stable-per-protocol | always literal `"2.0"` |
| `id` | int \| string \| null | required for request/response | client-generated | per-call | omit for notifications |
| `method` | string | required for request | per MCP method table below | stable-per-protocol | dotted namespace (e.g. `tools/call`) |
| `params` | object \| array | optional | per method | per-call | shape depends on `method` |
| `result` | object | required for success response | server | per-call | mutually exclusive with `error` |
| `error.code` | int | required for error response | server | stable | -32600..-32603 + MCP-specific codes |
| `error.message` | string | required for error response | server | per-call | human-readable |

Lifecycle: spawn → `initialize` request/response handshake → `tools/list`
+ `prompts/list` + `resources/list` discovery → repeated `tools/call` →
shutdown via process exit (no graceful shutdown method).

---

## Transport 2: Streamable HTTP (preferred for HTTP-capable apps)

**Selector**: `entry.transport === "streamable-http"`
**Connector**: `MCP.add({type: "remote", url})` →
`StreamableHTTPClientTransport`.
**Source**: `packages/opencode/src/mcp/index.ts` `connectMcpApps`
remote branch.

Frame format: client `POST <url>` with single JSON-RPC request as body
(`Content-Type: application/json`). Server responds with either:

- `Content-Type: application/json` — single JSON-RPC response.
- `Content-Type: text/event-stream` — multiple SSE events, each `data:`
  payload is one JSON-RPC message (response or server-initiated
  notification). Stream ends on server close.

| Field | Type / Encoding | Required | Source (file:line) | Stability | Notes |
|---|---|---|---|---|---|
| HTTP method | string `POST` | required | client | stable | `GET` reserved for future server-push session |
| `Content-Type` (req) | `application/json` | required | client | stable | UTF-8 body |
| `Content-Type` (resp) | `application/json` \| `text/event-stream` | required | server | stable | server picks based on whether streaming is needed |
| `Accept` (req) | `application/json, text/event-stream` | recommended | client | stable | signals SSE capability |
| body / event payload | JSON-RPC 2.0 object | required | both | stable-per-protocol | identical schema as stdio |

OpenCMS extension — **Unix-domain-socket URL form**:

```
url = "/<absolute/socket/path>:/<http-path>"
       └── socket path ──────┘ └── HTTP path on socket ──┘
```

Split on the **first `:` after a path-like prefix** (`packages/opencode/src/mcp/index.ts`
~L20 `parseUnixSocketUrl`). The transport then dials the unix socket
and emits HTTP/1.1 with the right-side as request-target. SSE fallback
is attempted second if Streamable HTTP returns 405 / non-2xx on the
initial POST.

Example: `/run/docxmcp/docxmcp.sock:/mcp` — POST to socket
`/run/docxmcp/docxmcp.sock`, request line `POST /mcp HTTP/1.1`.

---

## Transport 3: SSE (legacy, fallback only)

**Selector**: `entry.transport === "sse"` (or auto-fallback from
streamable-http)
**Connector**: `SSEClientTransport`.

Frame format: long-lived `GET <url>` returns `text/event-stream`;
client sends requests via separate `POST` to the same URL. Each SSE
event's `data:` payload is one JSON-RPC message.

Identical JSON-RPC field semantics as Streamable HTTP. Kept only for
servers that have not yet implemented Streamable HTTP.

---

## MCP method coverage (subset OpenCMS uses)

| Method | Direction | When called | Result shape |
|---|---|---|---|
| `initialize` | client → server | first message after connect | `{ protocolVersion, capabilities, serverInfo }` |
| `notifications/initialized` | client → server (notification) | after initialize success | — |
| `tools/list` | client → server | post-initialize, then per dirty-flag refresh round | `{ tools: [{ name, description, inputSchema }] }` |
| `tools/call` | client → server | every AI tool invocation routed through MCP | `{ content: [{type, ...}], isError?, structuredContent? }` |
| `resources/list` | client → server | post-initialize discovery | `{ resources: [{ uri, name, mimeType, ... }] }` |
| `prompts/list` | client → server | post-initialize discovery | `{ prompts: [{ name, description, arguments }] }` |
| `notifications/tools/list_changed` | server → client (notification) | server-driven dirty-flag | — (triggers next-round refresh) |

`tools/call` request `params` shape:

```json
{
  "name": "<tool name>",
  "arguments": { "<key>": <value>, ... }
}
```

`tools/call` result `content[]` element shapes (variant by `type`):

| `type` | Required fields | Notes |
|---|---|---|
| `text` | `text: string` | bulk of OpenCMS tool output |
| `image` | `data: base64`, `mimeType: string` | inlined; not piped through file-tab adapter |
| `resource` | `resource: { uri, mimeType, text? \| blob? }` | resource handle reference |

---

## OpenCMS extension: `structuredContent.bundle_tar_b64`

**Where**: returned inside `tools/call` result alongside `content[]`,
in the `structuredContent` field.
**Triggered by**: any mcp-app that processes uploaded files (docxmcp
is the reference impl; the SOP is documented at the bottom of
`specs/architecture.md`).
**Source**: `packages/opencode/src/incoming/dispatcher.ts` `after()`
hook decodes and materializes; reference producer
`/home/pkcs12/projects/docxmcp/bin/mcp_server.py` `_maybe_build_bundle`.

| Field | Type / Encoding | Required | Source | Stability | Notes |
|---|---|---|---|---|---|
| `structuredContent.bundle_tar_b64` | base64-encoded gzipped tar | optional | mcp-app (server) | per-call | snapshot+diff: only NEW files since pre-snapshot |
| `structuredContent.bundle_root` | string (path) | optional | mcp-app | per-call | relative root inside the tar; defaults to token_dir |

Dispatcher decodes bundle, untars to `<repoRoot>/<sourceDir>/<stem>/`,
emits `incoming.dispatcher.bundle-published` bus event. The original
upload is **not** included in the bundle (per SOP rule #4); only
NEW/touched files. Maximum bundle size soft-bounded by the
container's working tree.

This is the **only sanctioned IPC** for files going host ← container;
host bind-mounts are banned at register-time (see `mcp.store.bind-mount-rejected`
event and the lint described in README §"Bind-mount lint with narrow
IPC exception").

---

## Cross-references

- **IDEF0 / GRAFCET**: triggered-by activity for these wire messages
  is the lazy-connect + per-round dirty-refresh flow described in
  `mcp/idef0.json` and `mcp/grafcet.json`.
- **Module architecture**: this datasheet covers L7 (External MCP
  servers) and the L6 → L7 boundary of the stack diagram in
  `specs/architecture.md`.
- **Account / OAuth datasheet** (TBD): Google OAuth token sharing
  between mcp-apps via `gauth.json` is a separate wire surface and
  warrants its own datasheet under `specs/account/`.
- **MCP standard**: this datasheet documents only the subset OpenCMS
  uses or extends. Full upstream reference at
  https://modelcontextprotocol.io/specification.
