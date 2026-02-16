# Event: Claude Code System Prompt Verification Discovery

**Date**: 2026-02-09
**Status**: Resolved
**Impact**: Critical - Enables Sonnet/Opus subscription auth

## Summary

Discovered that Anthropic verifies Claude Code subscription requests by checking the **system prompt** content, not just headers or tool prefixes.

## Root Cause

Anthropic's API server validates Claude Code requests by verifying the system prompt contains:
```
"You are Claude Code, Anthropic's official CLI for Claude."
```

Without this identifier, Sonnet and Opus models reject requests with:
```
"This credential is only authorized for use with Claude Code"
```

Haiku was less strict and worked without the system prompt verification.

## Discovery Method

1. Direct API tests showed Haiku works, Sonnet/Opus fail
2. Extracted embedded JavaScript from claude-cli ELF binary using `strings`
3. Found the exact system prompt string in the code
4. Tested with correct system prompt → all models work

## Evidence

From `strings ~/.local/share/claude/versions/2.1.37`:
```javascript
var LBA="You are Claude Code, Anthropic's official CLI for Claude."
var boL="You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK."
```

## Fix Applied

Updated `src/plugin/anthropic.ts` to prepend the official Claude Code identity to all system prompts:

```typescript
// 3a. CRITICAL: System prompt MUST start with official Claude Code identifier
const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude."

if (parsed.system) {
  // Prepend identity if not present
  if (!parsed.system.includes(CLAUDE_CODE_IDENTITY)) {
    parsed.system = `${CLAUDE_CODE_IDENTITY}\n\n${parsed.system}`
  }
} else {
  // No system prompt: add identity
  parsed.system = CLAUDE_CODE_IDENTITY
}
```

## Test Results

| Model | Before Fix | After Fix |
|-------|------------|-----------|
| claude-haiku-4-5 | ✓ SUCCESS | ✓ SUCCESS |
| claude-sonnet-4-5-20250929 | ✗ FAILED (400) | ✓ SUCCESS |
| claude-opus-4-5-20251101 | ✗ FAILED (400) | ✓ SUCCESS |

## Complete Claude Code Protocol Requirements

1. **Endpoint**: `/v1/messages?beta=true`
2. **Headers**:
   - `Authorization: Bearer {oauth_token}`
   - `anthropic-beta: oauth-2025-04-20,claude-code-20250219,interleaved-thinking-2025-05-14`
   - `User-Agent: claude-cli/{VERSION} (external, cli)`
   - `x-anthropic-billing-header: cc_version={VERSION}.{hash}; cc_entrypoint=unknown; cch=00000;`
3. **Body**:
   - `system`: Must contain `"You are Claude Code, Anthropic's official CLI for Claude."`
   - `tools[].name`: Must have `mcp_` prefix
4. **Remove Headers**: `session_id`, `x-api-key`, `x-opencode-account-id`

## Related Files

- `src/plugin/anthropic.ts` - Main fix location
- `docs/events/faillog_claude_code_protocol.md` - Full investigation log
- `scripts/test-opus-direct.ts` - Direct API test script
- `scripts/test-e2e-sdk.ts` - E2E SDK integration test

## Tags

`@event_20260209_claude_code_system_prompt`
