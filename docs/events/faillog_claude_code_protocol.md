# Fail Log: Claude Code Protocol Reverse Engineering

**Objective:** Replicate Claude Code CLI (v2.1.37) authentication and session protocol to enable Subscription (Pro/Max) usage within OpenCode.

**Status:** Partial Success (Haiku works, Opus/Session Init fails).

## Timeline of Failures & Discoveries

### 1. The "Extra Inputs" Era
- **Attempt**: Inject `session_id`, `user_type`, `client_type` into `/v1/messages` JSON body (based on network packet capture).
- **Result**: `400 Bad Request: Extra inputs are not permitted`.
- **Root Cause**: The API schema for `/v1/messages` is strict and does not allow these fields at the top level. They likely belong in `metadata` or are handled via headers/session API.

### 2. The "Credential Authorized Only for Claude Code" Era
- **Attempt**: Remove extra body fields, rely on headers (`anthropic-client`, `User-Agent`).
- **Result**: `400 Bad Request: This credential is only authorized for use with Claude Code...`.
- **Hypothesis**: The server checks for specific headers or TLS fingerprinting to ensure the request comes from the official CLI.
- **Fix Attempts**:
  - Mimic `User-Agent: claude-code/2.1.37`. -> Failed.
  - Mimic legacy `User-Agent: claude-cli/2.1.2 (external, cli)`. -> Failed.
  - Remove `anthropic-client` header. -> Failed.

### 3. The "Missing Scope" Discovery
- **Discovery**: `cli.js` analysis revealed the official scope includes `user:sessions:claude_code` and `user:mcp_servers`.
- **Previous State**: We had removed these scopes to match an old reference implementation (`opencode-anthropic-auth`).
- **Impact**: Missing these scopes likely caused the Session API to return 404 and the Message API to reject the token.
- **Fix**: Restored full scopes. **User re-login required.**

### 4. The "Session Init 404" Mystery
- **Attempt**: Call `POST https://api.anthropic.com/v1/sessions` to initialize session.
- **Result**: `404 Not Found`.
- **Analysis**:
  - URL is correct per `cli.js` (`BASE_API_URL` + `/v1/sessions`).
  - **Hypothesis 1**: Missing `anthropic-version: 2023-06-01` header. (Added, still failing?)
  - **Hypothesis 2**: Incorrect Body format. We used `{env, core}`, but `cli.js` suggests `{sources, outcomes, model}`.
  - **Hypothesis 3**: Endpoint requires a specific Beta flag that we are missing (or sending too many).

### 5. The "Haiku Success" Anomaly
- **Observation**: Logs showed a successful `/v1/messages` call to `claude-haiku-4-5` (Title generation) *immediately after* a failed Session Init.
- **Implication**: The Protocol *is* partially working. The Subscription Token *is* accepted for some requests.
- **Why Opus Fails?**:
  - Opus requests usually include **Tools**.
  - Requests with Tools might enforce strict Session context (which failed to init).
  - Or Opus requires the `anthropic-beta: claude-code-20250219` flag to be respected, which might require a valid Session.

## Current Working Hypothesis
1. **Scope** is now correct.
2. **Headers** are mostly correct (added `anthropic-version`).
3. **Session API** (`/v1/sessions`) is the bottleneck. It returns 404.
   - If we fix this, we get a valid Session ID.
   - We can then pass this Session ID (via header `anthropic-session-id` or metadata) to `/v1/messages`.
   - This should unlock full capability (Tools/Opus).

## Action Items
- [x] Restore full scopes.
- [x] Add `anthropic-version` header.
- [x] Update Session Init Body to match `cli.js` structure (`{sources, outcomes, model}`).
- [ ] Investigate if `v1/sessions` requires `x-api-key` even for OAuth? (Unlikely).
- [ ] Investigate if `v1/sessions` endpoint path changed in v2.1.37 (e.g. `/api/sessions`).

## Reference Code Snippets (from cli.js)
```javascript
// Scopes
pS6=["user:profile",kx,"user:sessions:claude_code","user:mcp_servers"]

// Headers Helper (S0)
function S0(A){return{Authorization:`Bearer ${A}`,"Content-Type":"application/json","anthropic-version":"2023-06-01"}}

// Session URL
let K=${X4().BASE_API_URL}/v1/sessions
```
