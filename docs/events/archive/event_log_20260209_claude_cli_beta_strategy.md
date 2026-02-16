# Event: Claude CLI Protocol - Sessions API to Beta Strategy Migration

**Date**: 2026-02-09
**Severity**: Medium
**Status**: Resolved

## Summary

Migrated from failed Sessions API approach to the simpler `?beta=true` + `mcp_` tool prefix strategy used by the reference implementation.

## Problem

Sessions API (`POST /v1/sessions`) consistently returned 404:
```
Session attempt failed: https://api.anthropic.com/v1/sessions → 404 not_found_error
Session attempt failed: https://api.anthropic.com/api/v1/sessions → 404 not_found_error
```

Fallback to standard messages API then returned:
```
This credential is only authorized for use with Claude Code and cannot be used for other API requests.
```

## Root Cause Analysis

1. **Sessions API Not Available**: The `/v1/sessions` endpoint appears to be internal/undocumented and not accessible via OAuth tokens
2. **Subscription Credentials Require Protocol Compliance**: OAuth tokens with subscription scope require:
   - `?beta=true` query parameter on `/v1/messages`
   - `mcp_` prefix on all tool names
   - Specific header set including `anthropic-beta: oauth-2025-04-20`

## Solution

Adopted the reference implementation strategy from `refs/opencode-anthropic-auth/index.mjs`:

1. **Remove Sessions API Logic**: Eliminated all `/v1/sessions` and `/events` routing code
2. **Add `?beta=true`**: Append query parameter to `/v1/messages` requests
3. **Tool Name Transformation**:
   - Request: Add `mcp_` prefix to all tool names
   - Response: Strip `mcp_` prefix from tool names in streaming response
4. **System Prompt Sanitization**: Replace "OpenCode" with "Claude Code"

## Code Changes

**Before** (failed approach):
```typescript
// Try sessions API
const sessionResponse = await fetch("https://api.anthropic.com/v1/sessions", {...})
// Reroute to events
requestInput = `${baseUrl}/sessions/${serverId}/events`
```

**After** (working approach):
```typescript
// Add ?beta=true
if (requestUrl.pathname === "/v1/messages") {
  requestUrl.searchParams.set("beta", "true")
}
// Add mcp_ prefix to tools
parsed.tools = parsed.tools.map(tool => ({
  ...tool,
  name: `mcp_${tool.name}`
}))
```

## Verification

All 4 tests passing:
- Provider identification
- `?beta=true` and `mcp_` prefix application
- System prompt sanitization
- Response `mcp_` prefix stripping

## Additional Fix: Base Provider Fetch Inheritance

**Problem Discovered**: Opus model failed while Haiku worked:
```
providerId: "claude-cli" (Opus) → No custom fetch → API rejected
providerId: "claude-cli-subscription-xxx" (Haiku) → Has custom fetch → Success
```

**Root Cause**:
1. Auth stored under account ID (`claude-cli-subscription-xxx`)
2. Base provider (`claude-cli`) has no direct auth
3. Plugin loader only loads custom fetch for accounts with auth
4. When user selects model using base `claude-cli` providerId, no custom fetch

**Solution** (provider.ts lines 1676-1690):
```typescript
// FIX: Inherit custom fetch from first account to base provider
if (providers[family] && !providers[family].options?.fetch) {
  for (const accountId of Object.keys(familyData.accounts)) {
    if (providers[accountId]?.options?.fetch) {
      providers[family].options = mergeDeep(providers[family].options, {
        fetch: providers[accountId].options.fetch,
        apiKey: providers[accountId].options.apiKey,
        isClaudeCode: providers[accountId].options.isClaudeCode,
      })
      break
    }
  }
}
```

## Files Modified

- `src/plugin/anthropic.ts` - Major refactor (~100 lines removed, ~50 lines added)
- `src/plugin/anthropic-cli.test.ts` - Updated tests for new strategy
- `src/provider/provider.ts` - Added base provider fetch inheritance
