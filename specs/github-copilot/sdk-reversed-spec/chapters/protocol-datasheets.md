# Protocol Datasheets — GitHub Copilot SDK

## 1. JSON-RPC Connect Handshake (SDK → CLI)

**Transport**: JSON-RPC 2.0 request over stdio pipes / TCP socket
**Triggered by**: IDEF0-01 A4 (Negotiate Protocol Version)
**Source**: `nodejs/src/client.ts:470+`

| Field | Type / Encoding | Required | Source (file:line) | Stability | Notes |
|---|---|---|---|---|---|
| `jsonrpc` | string `"2.0"` | required | vscode-jsonrpc | stable | JSON-RPC envelope |
| `method` | string `"connect"` | required | `nodejs/src/generated/rpc.ts` | stable | Server-scoped RPC |
| `params.sdkProtocolVersion` | integer (currently 3) | required | `sdk-protocol-version.json` | per-release | Bumped on breaking changes |
| `params.connectionToken` | string | optional | client.ts constructor | stable-per-session | TCP auth token |
| `params.gitHubToken` | string (`gho_`, `ghu_`, `github_pat_`) | optional | CopilotClientOptions | per-session | GitHub identity |
| `params.useLoggedInUser` | boolean | optional | CopilotClientOptions | per-session | false = explicit token only |

**Response** (CLI → SDK):

| Field | Type / Encoding | Required | Source (file:line) | Stability | Notes |
|---|---|---|---|---|---|
| `result.protocolVersion` | integer | required | rpc.ts ConnectResult | per-release | Must be >= 2 |
| `result.sdkPackageVersion` | string | required | rpc.ts ConnectResult | per-release | CLI's bundled SDK version |

**Example payload** (sanitized):
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "connect",
  "params": {
    "sdkProtocolVersion": 3,
    "gitHubToken": "gho_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "useLoggedInUser": false
  }
}
```

---

## 2. Session Send (SDK → CLI)

**Transport**: JSON-RPC 2.0 request `session.send`
**Triggered by**: IDEF0-02 A2 (Send User Prompt)
**Source**: `nodejs/src/session.ts` (send method)

| Field | Type / Encoding | Required | Source (file:line) | Stability | Notes |
|---|---|---|---|---|---|
| `params.prompt` | string | required | session.ts:send() | per-turn | User message text |
| `params.attachments` | array of {path, mimeType} | optional | types.ts MessageOptions | per-turn | File attachments |
| `params.reasoningEffort` | `"low"` \| `"medium"` \| `"high"` | optional | types.ts ReasoningEffort | per-turn | Extended thinking control |
| `params.model` | string | optional | types.ts MessageOptions | per-turn | Override session model |

**Response**:

| Field | Type / Encoding | Required | Source (file:line) | Stability | Notes |
|---|---|---|---|---|---|
| `result.messageId` | UUID v4 string | required | session.ts | per-turn | Correlates with events |

---

## 3. Session Event Envelope (CLI → SDK)

**Transport**: JSON-RPC 2.0 notification (no response expected)
**Triggered by**: IDEF0-05 A1 (Receive Raw Event Notification)
**Source**: `nodejs/src/generated/session-events.ts`

| Field | Type / Encoding | Required | Source (file:line) | Stability | Notes |
|---|---|---|---|---|---|
| `id` | UUID v4 string | required | session-events.ts | per-event | Unique event identifier |
| `timestamp` | ISO 8601 string | required | session-events.ts | per-event | Server-assigned time |
| `parentId` | UUID v4 string \| null | required | session-events.ts | per-event | Linked list chain to previous |
| `ephemeral` | boolean | optional | session-events.ts | per-event | true = transient, not persisted |
| `type` | string enum (40+ values) | required | session-events.ts | stable | Discriminator field |
| `data` | object (varies by type) | required | session-events.ts | varies | Type-specific payload |

**Key Event Types**:

| type | data shape | Stability |
|------|-----------|-----------|
| `assistant.message` | `{ content: string }` | stable |
| `assistant.message_delta` | `{ deltaContent: string }` | stable |
| `assistant.reasoning_delta` | `{ deltaContent: string }` | stable |
| `assistant.turn_start` | `{}` | stable |
| `assistant.turn_end` | `{}` | stable |
| `session.idle` | `{}` | stable |
| `session.end` | `{ reason: string }` | stable |
| `session.error` | `{ message: string, code?: string }` | stable |
| `tool.execution_start` | `{ toolName, args }` | stable |
| `tool.execution_complete` | `{ toolName, result }` | stable |
| `external_tool.requested` | `{ toolName, args, invocation }` | stable |
| `permission.requested` | `{ type, toolName, args }` | stable |
| `subagent.started` | `{ agentName, sessionId }` | stable |
| `subagent.completed` | `{ agentName, result }` | stable |

**Example payload** (sanitized):
```json
{
  "jsonrpc": "2.0",
  "method": "session.event",
  "params": {
    "id": "00000000-0000-4000-8000-000000000001",
    "timestamp": "2026-05-18T10:00:00.000Z",
    "parentId": null,
    "type": "assistant.message_delta",
    "data": {
      "deltaContent": "Here is the code"
    }
  }
}
```

---

## 4. Tool Call Request (CLI → SDK)

**Transport**: JSON-RPC 2.0 request (expects response)
**Triggered by**: IDEF0-03 A1 (Receive Tool Call Request)
**Source**: `nodejs/src/session.ts`, `nodejs/src/generated/rpc.ts`

| Field | Type / Encoding | Required | Source (file:line) | Stability | Notes |
|---|---|---|---|---|---|
| `params.toolName` | string | required | rpc.ts | per-turn | Registered tool name |
| `params.args` | JSON object | required | rpc.ts | per-turn | Arguments matching tool schema |
| `params.invocation.sessionId` | string | required | types.ts ToolInvocation | per-session | Session context |
| `params.invocation.timestamp` | number | optional | types.ts ToolInvocation | per-turn | Call timestamp |
| `params.invocation.traceparent` | string | optional | types.ts ToolInvocation | per-turn | W3C Trace Context |

**Response** (SDK → CLI):

| Field | Type / Encoding | Required | Source (file:line) | Stability | Notes |
|---|---|---|---|---|---|
| `result.textResultForLlm` | string | required | types.ts ToolResultObject | per-turn | Text fed back to model |
| `result.resultType` | `"success"` \| `"failure"` \| `"rejected"` \| `"denied"` \| `"timeout"` | required | types.ts | per-turn | Outcome classification |
| `result.binaryResultsForLlm` | array of {data, mimeType, type, description} | optional | types.ts | per-turn | Images, files |
| `result.error` | string | optional | types.ts | per-turn | Error message if failure |
| `result.toolTelemetry` | object | optional | types.ts | per-turn | Custom metrics |

---

## 5. OAuth Device Flow (OpenCMS Implementation)

**Transport**: HTTPS POST to GitHub OAuth endpoints
**Triggered by**: IDEF0-04 A2 (Pass Token via Connect Handshake) — upstream implementation in OpenCMS `plugin/copilot.ts`
**Source**: `packages/opencode/src/plugin/copilot.ts:199-366`

### 5a. Device Code Request

| Field | Type / Encoding | Required | Source (file:line) | Stability | Notes |
|---|---|---|---|---|---|
| URL | `https://github.com/login/device/code` | — | copilot.ts:213 | stable | GitHub endpoint |
| `client_id` | string `"Ov23li8tweQw6odWQebz"` | required | copilot.ts:5 | stable | Copilot OAuth App ID |
| `scope` | string `"read:user"` | required | copilot.ts:223 | stable | Minimal scope |

**Response**:

| Field | Type / Encoding | Required | Source (file:line) | Stability | Notes |
|---|---|---|---|---|---|
| `verification_uri` | URL string | required | copilot.ts:231 | stable | User visits this |
| `user_code` | 8-char string | required | copilot.ts:232 | per-flow | User enters this |
| `device_code` | string | required | copilot.ts:233 | per-flow | Used for polling |
| `interval` | integer (seconds) | required | copilot.ts:234 | per-flow | Polling interval |
| `expires_in` | integer (seconds) | optional | copilot.ts:244 | per-flow | Code TTL |

### 5b. Token Polling

| Field | Type / Encoding | Required | Source (file:line) | Stability | Notes |
|---|---|---|---|---|---|
| URL | `https://github.com/login/oauth/access_token` | — | copilot.ts:257 | stable | GitHub token endpoint |
| `client_id` | string | required | copilot.ts:265 | stable | Same as device request |
| `device_code` | string | required | copilot.ts:266 | per-flow | From step 5a |
| `grant_type` | `"urn:ietf:params:oauth:grant-type:device_code"` | required | copilot.ts:267 | stable | RFC 8628 |

**Polling responses**:
- `{ "error": "authorization_pending" }` → wait + retry
- `{ "error": "slow_down" }` → increase interval by 5s (RFC)
- `{ "error": "access_denied" }` → fail
- `{ "error": "expired_token" }` → fail
- `{ "access_token": "gho_..." }` → success

### 5c. Copilot API Request Headers

**Transport**: HTTPS to `https://api.githubcopilot.com` (or enterprise variant)
**Source**: `packages/opencode/src/plugin/copilot.ts:137-155`

| Header | Value | Source | Notes |
|---|---|---|---|
| `Authorization` | `Bearer ${info.refresh}` (= GitHub access_token) | copilot.ts:142 | Not a Copilot-specific token! |
| `User-Agent` | `opencode/${VERSION}` | copilot.ts:141 | Installation version |
| `Openai-Intent` | `conversation-edits` | copilot.ts:143 | Required by Copilot API |
| `x-initiator` | `"agent"` \| `"user"` | copilot.ts:138 | Agent vs user turn |
| `Copilot-Vision-Request` | `"true"` | copilot.ts:146 | When images present |

---

## 6. SessionFs RPC (CLI → SDK)

**Transport**: JSON-RPC 2.0 request/response
**Triggered by**: CLI needs filesystem access in custom storage mode
**Source**: `nodejs/src/sessionFsProvider.ts`

| Method | Params | Response | Notes |
|---|---|---|---|
| `sessionFs.readFile` | `{ path: string }` | `{ content: string }` | UTF-8 text |
| `sessionFs.writeFile` | `{ path, content, mode? }` | `{}` | Creates dirs as needed |
| `sessionFs.appendFile` | `{ path, content, mode? }` | `{}` | |
| `sessionFs.exists` | `{ path }` | `{ exists: boolean }` | |
| `sessionFs.stat` | `{ path }` | `{ size, isFile, isDirectory, mtime }` | |
| `sessionFs.mkdir` | `{ path, recursive, mode? }` | `{}` | |
| `sessionFs.readdir` | `{ path }` | `{ entries: string[] }` | |
| `sessionFs.readdirWithTypes` | `{ path }` | `{ entries: [{name, isFile, isDir}] }` | |
| `sessionFs.rm` | `{ path, recursive, force }` | `{}` | |
| `sessionFs.rename` | `{ src, dest }` | `{}` | |

**Error shape**: `{ code: "ENOENT" | "UNKNOWN", message: string }`
