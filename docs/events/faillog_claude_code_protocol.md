# Fail Log: Claude Code Protocol Reverse Engineering

**Objective:** Replicate Claude Code CLI (v2.1.37) authentication and session protocol to enable Subscription (Pro/Max) usage within OpenCode.

**Status:** Debugging Session Workflow (Attempt 10 Complete).

## Timeline of Failures & Discoveries

### 7. The "Missing Beta & Wrong Body" Session Discovery

- **Discovery**: `cli.js` analysis shows `POST /v1/sessions` requires specific Beta flags and a complex body.
- **RCA**: Previous 404s on `/v1/sessions` were due to missing `oauth-2025-04-20` and malformed JSON.

### 8. The "Credential Authorized Only for Claude Code" Persisting

- **RCA**: This error occurs when a Claude Code token is used on the Public `/v1/messages` endpoint.
- **Goal**: Transition fully to the **Sessions API** protocol.

### 9. The "Reroute 404"

- **Attempt**: Redirect `/v1/messages` to `POST /v1/sessions/{local_uuid}/events`.
- **Result**: `404 Not Found`.
- **Root Cause**: The Sessions API requires a **Server-side Session ID** returned by the initial `POST /v1/sessions` call. Using a local UUID in the URL path is invalid.

### 10. The "Full Protocol Sync" (Current Design)

- **Discovery**: Analysis of `HG1`, `A51`, and `oD6` functions in `cli.js` reveals:
  - **Environment Discovery**: Must call `/v1/environment_providers` to get an `environment_id`.
  - **Dual Beta Activation**: Requires `oauth-2025-04-20` AND `claude-code-20250219`.
  - **Correct UA**: User-Agent must be `claude-code/2.1.37`.
  - **ID Mapping**: Must capture the server-generated ID from the session creation response and use it for all subsequent events.
- **Fix Applied**: Implemented the full environment -> session -> events mapping workflow.

## Current Working Hypothesis

The full official workflow (Environment Discovery -> Session Init with Beta Flags -> Event Rerouting with Server ID) is now implemented. This should bypass the credential check by staying strictly within the authorized CLI protocol paths.

## Action Items

- [x] Implement Environment Discovery (`/v1/environment_providers`).
- [x] Enable Dual Beta Flags (`oauth-2025-04-20`, `claude-code-20250219`).
- [x] Implement Session ID Mapping (Local ID -> Server ID).
- [x] Reroute standard messages to `/v1/sessions/{server_id}/events` using the `oD6` payload structure.

## Reference Code Snippets (from cli.js)

```javascript
// oD6: Sending Event
let $ = { events: [{ uuid: iMY(), session_id: A, type: "user", message: { role: "user", content: q } }] }

// A51: Creating Session
let N = { title: _, events: Z, session_context: V, environment_id: W }
```
