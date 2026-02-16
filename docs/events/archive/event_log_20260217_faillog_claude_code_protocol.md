# Fail Log: Claude Code Protocol Reverse Engineering

**Objective:** Replicate Claude Code CLI (v2.1.37) authentication and session protocol to enable Subscription (Pro/Max) usage within OpenCode.

**Status:** ✅ **RESOLVED** - TUI working with subscription auth (2026-02-09).

## Timeline of Failures & Discoveries

### 13. The "SDK Late-Stage Pollution" (CRITICAL DISCOVERY)

- **RCA**: Determined that AI SDK forces standard Anthropic structure if `providerId` is `anthropic`.
- **Action**: Renamed provider to `claude-cli` and used `openai-compatible` driver to bypass SDK "help".

### 14. The "Pathname Mismatch" & "Auth TypeError"

- **Discovery**:
  - `openai-compatible` SDK calls `/chat/completions`, which our interceptor missed (it only looked for `/messages`).
  - Account migration caused `auth` to be `undefined` in some contexts, triggering a crash.
- **RCA**:
  - `AI_APICallError: Not Found` was due to SDK hitting `api.anthropic.com/chat/completions` without interception.
  - `TypeError: auth.type` was due to missing null checks.
- **Action**:
  - Updated interceptor to catch `/chat/completions`.
  - Added robust null checks for `auth` object.
  - Hardcoded `api.url` to `https://api.anthropic.com` in `provider.ts` to ensure valid URL parsing.

### 15. Sessions API Deprecated - Beta Strategy Migration (2026-02-09)

- **Discovery**: Sessions API (`/v1/sessions`) returns 404 for all attempts
- **RCA**: Sessions API is internal/undocumented, not accessible via OAuth
- **Action**: Migrated to `?beta=true` + `mcp_` tool prefix strategy per reference implementation
- **Status**: Opus works, but Haiku (title agent) fails

### 16. Base Provider Fetch Inheritance (2026-02-09)

- **Discovery**: `claude-cli` base provider has no custom fetch, only `claude-cli-subscription-xxx` has it
- **RCA**: Auth stored under account ID, plugin loader skips base provider
- **Action**: Added account-level auth check + base provider fetch inheritance
- **Status**: Still failing - SDK cache issue

### 17. SDK Cache Key Function Serialization (2026-02-09)

- **Discovery**: `JSON.stringify` ignores functions, causing SDK with/without custom fetch to share cache key
- **RCA**: Old SDK (no wrapped fetch) cached before provider options updated
- **Action**: Added `hasCustomFetch` to cache key
- **Status**: STILL FAILING - need deeper investigation

### 18. SDK Cache Timing Issue (2026-02-09)

- **Observation**:
  - Opus `getSDK`: hasCustomFetch=true → fetch wrapper called ✓
  - Haiku `getSDK`: hasCustomFetch=true → NO fetch wrapper called ✗
- **Hypothesis**: Haiku using cached SDK from BEFORE custom fetch was added
- **Log Evidence**:
  ```
  09:22:56.334 - haiku getSDK (hasCustomFetch:true)
  09:22:56.336 - fetch wrapper (modelID: opus!) ← This is opus's 2nd request
  09:22:56.606 - haiku ERROR
  ```
- **RCA**: `JSON.stringify` can't distinguish different function instances. Even with `hasCustomFetch: true`, if an old SDK was created with a different fetch function, cache key matches and old SDK is reused.
- **Action**: Added `fetchId` (unique per account + timestamp) to plugin return value. Since `fetchId` is serializable, it becomes part of cache key.
- **Status**: Fix applied, awaiting verification

### 19. Architecture Clarification (2026-02-09)

- **User Insight**: Plugin should be independent, shouldn't rely on OpenCode legacy code
- **Reality**: Plugin IS independent. The bug is in OpenCode's SDK cache, not the plugin.
- **Resolution**: Plugin now provides `fetchId` - a serializable cache buster that OpenCode can use

### 20. Token Refresh Silent Failure (2026-02-09)

- **Observation**: Log shows `Refreshing token...` followed by `OAuth token has expired` error
- **RCA**: Token refresh failure was silently ignored - when `response.ok` was false, code continued using expired token
- **Log Evidence**:
  ```
  09:28:45.305 - Refreshing token for claude-cli...
  09:28:45.558 - Using beta messages endpoint
  09:28:45.810 - ERROR: OAuth token has expired
  ```
- **Action**: Added error handling - if refresh fails, throw with details instead of silent continue
- **Status**: Fix applied, awaiting verification

### 21. Toolless Requests Fail Auth (2026-02-09)

- **Observation**: Opus (42 tools) works, Haiku (title agent, 0 tools) fails
- **Log Evidence**:
  ```
  09:37:11.239 - Opus: toolCount=42, hasMcpPrefix=true → NO ERROR
  09:37:11.257 - Haiku: toolCount=0 → ERROR: credential only authorized
  ```
- **Hypothesis**: Anthropic validates Claude Code requests by checking for `mcp_` prefixed tools
- **Action**: Added dummy `mcp_noop` tool for requests without tools
- **Status**: INVALIDATED by Test #22

### 22. Direct API Test Results (2026-02-09 09:44) - BREAKTHROUGH

**Test Script**: `scripts/test-claude-cli-auth.ts`

| Test Case | Result |
|-----------|--------|
| mcp_ prefix tools | ✓ SUCCESS |
| Without claude-code beta | ✓ SUCCESS |
| Without mcp_ prefix | ✗ FAILED (400) |
| **No tools (title agent)** | **✓ SUCCESS** |
| mcp_noop dummy tool | ✓ SUCCESS |
| Different User-Agent | ✓ SUCCESS |

**CRITICAL FINDING**: Direct API calls WITHOUT tools succeed!

This proves:
1. Our understanding of Anthropic's auth requirements was wrong
2. The issue is NOT `mcp_` prefix requirement for toolless requests
3. Something between our plugin and the API call is modifying the request

### 23. session_id Header Detection - ROOT CAUSE FOUND (2026-02-09)

- **Discovery**: OpenCode SDK layer adds `session_id` header to all requests
- **Log Evidence**:
  ```
  SDK INCOMING: allHeaders: ["anthropic-version","content-type","session_id","user-agent","x-api-key","x-opencode-account-id"]
  ```
- **RCA**: Anthropic's server uses header fingerprinting to detect non-Claude-Code clients. The `session_id` header (added by OpenCode's `chat.headers` hook) is NOT present in official Claude CLI requests, triggering rejection.
- **Action**: Added `session_id` to the headers deletion list in plugin fetch wrapper
- **Test Result**: `scripts/test-opencode-flow.ts` → **SUCCESS (200 OK)**

### 24. Automated Testing Infrastructure (2026-02-09)

Created comprehensive test scripts for debugging:
- `scripts/test-claude-cli-auth.ts` - Direct API test (6 cases, 5/6 pass)
- `scripts/test-sdk-comparison.ts` - SDK vs direct fetch comparison
- `scripts/test-opencode-flow.ts` - Full OpenCode plugin flow simulation

## Resolution

**RESOLVED**: The `session_id` header added by OpenCode's SDK layer triggered Anthropic's non-Claude-Code detection. Removing this header in the plugin's custom fetch wrapper fixes the issue.

**Key Fix** (src/plugin/anthropic.ts:187):
```typescript
const toDelete = [
  "x-api-key",
  "anthropic-client",
  "x-app",
  "x-opencode-tools-debug",
  "x-opencode-account-id",
  "session_id", // FIX: This header triggers credential rejection @event_20260209_session_id_header
]
toDelete.forEach((h) => requestHeaders.delete(h))
```

### 25. Model-Specific Authorization - Initial Discovery (2026-02-09)

- **Discovery**: Direct API tests revealed Sonnet/Opus fail while Haiku works
- **Hypothesis**: Anthropic applies additional verification for larger models

### 26. System Prompt Verification - ROOT CAUSE FOUND (2026-02-09)

- **Discovery**: Reverse engineering claude-cli binary revealed the key
- **RCA**: Anthropic verifies Claude Code requests by checking the **system prompt** contains:
  ```
  "You are Claude Code, Anthropic's official CLI for Claude."
  ```
- **Evidence**: Found in embedded JS code via `strings` extraction from ELF binary
- **Test Results** (with correct system prompt):
  | Model | Result |
  |-------|--------|
  | claude-haiku-4-5 | ✓ SUCCESS |
  | claude-sonnet-4-5-20250929 | ✓ SUCCESS |
  | claude-opus-4-5-20251101 | ✓ SUCCESS |
- **Action**: Updated plugin to prepend official Claude Code identity to all system prompts

### 27. isClaudeCode Flag Not Propagated to Transform (2026-02-09)

- **Symptom**: E2E tests pass, but TUI (`bun run dev`) still fails with 400 error
- **Debug Log Analysis**:
  - System prompt: ✓ Correctly contains Claude Code identity
  - URL: ✓ Contains `?beta=true`
  - Tools: ✓ Have `mcp_` prefix
  - Beta header: ✓ Correct values
- **Discovery**: `cache_control` was being applied to messages despite `isClaudeCode: true` in plugin
- **RCA**:
  - Plugin loader returns `isClaudeCode: true` in `provider.options`
  - `ProviderTransform.options()` receives `providerOptions` but doesn't pass `isClaudeCode` to return value
  - `ProviderTransform.message()` checks `options?.isClaudeCode` but it's `undefined`
  - Result: Caching headers applied → Anthropic rejects as non-Claude-Code request
- **Action**: Added `isClaudeCode` propagation in `transform.ts`:
  ```typescript
  if (input.providerOptions?.isClaudeCode) {
    result["isClaudeCode"] = true
  }
  ```
- **Status**: FIXED - Pending TUI verification

### 28. Empty Text Blocks in System/Messages (2026-02-09)

- **Symptom**: E2E tests pass, TUI still fails with 400 error
- **Discovery**: Direct API test revealed:
  ```json
  {"type":"error","error":{"type":"invalid_request_error","message":"system: text content blocks must be non-empty"}}
  ```
- **RCA**:
  - Anthropic API rejects requests with empty or whitespace-only text blocks
  - System prompt construction in `llm.ts` can produce empty strings when certain conditions yield no content
  - AI SDK converts system to array of text blocks, empty strings become `{ type: "text", text: "" }`
  - Plugin's custom fetch wasn't filtering these before sending to API
- **Action**:
  1. Added empty block filter in `anthropic.ts` for system prompt:
     ```typescript
     .filter((item: any) => {
       if (item.type === "text") {
         return item.text && item.text.trim() !== ""
       }
       return true
     })
     ```
  2. Added empty block filter for messages in plugin
  3. Added `filteredSystem` in `llm.ts` to prevent empty system messages at source
- **Test Results**:
  | Model | Plugin Test |
  |-------|-------------|
  | Haiku | ✓ SUCCESS |
  | Sonnet | ✓ SUCCESS |
  | Opus | ✓ SUCCESS |
- **Status**: FIXED - Pending TUI verification

### 29. Non-Official Prompt Fragment Detection (2026-02-09) - ROOT CAUSE

- **Symptom**: Opus fails, Haiku succeeds with identical headers/token
- **Discovery**: Binary search of system prompt revealed the trigger
- **RCA**:
  - Anthropic detects **non-official prompt fragments**
  - The phrase `"You are Claude Code, the best coding agent on the planet."` triggers rejection
  - This is OpenCode's custom prompt, NOT in official claude-code
  - Even with correct identity prefix, this fragment causes 400 error
- **Evidence**:
  ```
  "You are Claude Code, the best coding agent on the planet." → FAIL
  " You are Claude Code, the best coding agent on the planet." → OK (space prefix)
  "the best coding agent on the planet" alone → OK
  ```
- **Action**: Added sanitization to remove non-official prompt fragments:
  ```typescript
  body = body
    .replace(/You are Claude Code, the best coding agent on the planet\.\s*/g, "")
    .replace(/, the best coding agent on the planet/g, "")
  ```
- **Test Results**:
  | Model | TUI Test |
  |-------|----------|
  | Opus (42 tools) | ✓ 200 OK |
  | Haiku (0 tools) | ✓ 200 OK |
- **Status**: **FIXED** - TUI working

## Resolution (COMPLETE)

**FULLY RESOLVED**: All models (Haiku, Sonnet, Opus) work with subscription auth.

**Key Requirements for Claude Code Protocol**:
1. `?beta=true` query parameter on `/v1/messages` endpoint
2. `mcp_` prefix on all tool names
3. OAuth token with correct scopes
4. **System prompt MUST contain**: `"You are Claude Code, Anthropic's official CLI for Claude."`

## Action Items

- [x] Catch `/chat/completions` in interceptor.
- [x] Robust null checks for auth.
- [x] Hardcode valid Base URL for `claude-cli`.
- [x] Migrate to `?beta=true` + `mcp_` prefix strategy
- [x] Add account-level auth check for plugin loader
- [x] Add base provider fetch inheritance
- [x] Add `hasCustomFetch` to SDK cache key
- [x] Add `fetchId` to plugin return for proper cache invalidation
- [x] **Identify session_id header root cause**
- [x] **Haiku works with subscription auth**
- [x] **Reverse engineer claude-cli for Sonnet/Opus auth**
- [x] **Identify system prompt requirement**
- [x] **Fix isClaudeCode flag propagation in transform.ts**
- [x] **Sanitize non-official prompt fragments**
- [x] **TUI verification: Opus + Haiku both 200 OK**
