# Protocol Diff: anthropic.ts (2.1.39) vs Official CLI (2.1.92)

> Generated: 2026-04-07
> Purpose: Identify all mismatches between our implementation and official protocol

---

## Critical Fixes (breaks functionality or identity)

### 1. VERSION — `2.1.39` → `2.1.92`

**File**: `packages/opencode/src/plugin/anthropic.ts:11`

```typescript
// Before
const VERSION = "2.1.39"
// After
const VERSION = "2.1.92"
```

**Impact**: Affects `User-Agent`, billing header hash, identity detection.

---

### 2. OAuth Scopes — Missing `user:file_upload`

**File**: `anthropic.ts:72` (authorize) and `anthropic.ts:167-171` (refresh)

```typescript
// Before (authorize)
"org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers"
// After
"org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload"

// Before (refresh REFRESH_SCOPES)
["user:profile", "user:inference", "user:sessions:claude_code", "user:mcp_servers"]
// After
["user:profile", "user:inference", "user:sessions:claude_code", "user:mcp_servers", "user:file_upload"]
```

**Impact**: Without `user:file_upload`, Files API calls will fail.

---

### 3. Beta Flags — Hardcoded → Dynamic, Missing Required

**File**: `anthropic.ts:241`

```typescript
// Before
const requiredBetas = ["oauth-2025-04-20", "claude-code-20250219", "interleaved-thinking-2025-05-14"]

// After (minimum required — always sent)
const MINIMUM_BETAS = [
  "claude-code-20250219",
  "interleaved-thinking-2025-05-14",
  "context-management-2025-06-27",  // NEW
]
// oauth-2025-04-20 becomes conditional on auth type
// prompt-caching-scope-2026-01-05 added for OAuth
```

**Impact**: Missing `context-management` may degrade API behavior. `oauth` beta should be conditional.

---

### 4. Billing Header Content Source — Last → First User Message

**File**: `anthropic.ts:382-389`

```typescript
// Before: hashes LAST message
const lastMessage = parsed.messages[parsed.messages.length - 1]

// After: should hash FIRST non-meta user message
const firstUserMessage = parsed.messages.find(
  (m: any) => m.role === "user" && !m.meta
)
```

**Impact**: Billing header hash will differ from official. Unlikely to break functionality (server doesn't validate hash content) but diverges from protocol.

---

## Important Fixes (correctness / future-proofing)

### 5. Tool Prefix — `mcp_` → `mcp__` (double underscore)

**File**: `anthropic.ts:15`

```typescript
// Before
const TOOL_PREFIX = "mcp_"
// After (official 2.1.92)
const TOOL_PREFIX = "mcp__"
```

**Context**: Official format is `mcp__{serverName}__{toolName}`. Since OpenCode tools are not proxied through MCP servers, the server name component is N/A. Current `mcp_` prefix has been working — this is a protocol fidelity issue, not a functional break.

**Recommendation**: Change to `mcp__` for forward compatibility. Strip regex needs update too:
```typescript
// Before
/"name"\s*:\s*"mcp_([^"]+)"/g
// After
/"name"\s*:\s*"mcp__([^"]+)"/g
```

---

### 6. Claude.ai OAuth Endpoint — Missing Second Authorize URL

**File**: `anthropic.ts:65`

Our implementation only has Console authorize. Official 2.1.92 also supports:

```
https://claude.com/cai/oauth/authorize  (Claude.ai subscription users)
```

**Impact**: Users who have Claude.ai accounts (not Console) may need this flow. Low priority if we only target Console + subscription.

---

### 7. Roles Endpoint — New

Official 2.1.92 calls `/api/oauth/claude_cli/roles` to check user roles after auth. We don't implement this.

**Impact**: Low — role checking is informational, not blocking.

---

## Low Priority (nice-to-have / future features)

### 8. Conditional Beta Assembly

Official 2.1.92 computes betas per-request based on model, platform, and features. Our implementation sends the same betas for every request. See `beta-flags-datasheet.md` for full details.

**Recommendation**: Implement in phases as we add features (fast-mode, effort, etc.)

---

### 9. New Endpoints

| Endpoint | Beta | Priority |
|---|---|---|
| Files API (`/v1/files`) | `files-api-2025-04-14` | Medium — enables file upload |
| Skills API (`/v1/skills`) | `skills-2025-10-02` | Low |
| MCP Proxy | `mcp-servers-2025-12-04` | Low |
| Environments | `environments-2025-11-01` | Low |

---

### 10. System Prompt Variants — Agent SDK Variants

We only inject the primary identity. 2.1.92 also supports:

```
"You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK."
"You are a Claude agent, built on Anthropic's Claude Agent SDK."
```

**Impact**: Only relevant if we use Agent SDK mode. Low priority.

---

## Summary Action Matrix

| # | Item | Priority | Effort |
|---|---|---|---|
| 1 | VERSION → 2.1.92 | **P0** | 1 line |
| 2 | OAuth scopes + `user:file_upload` | **P0** | 2 lines |
| 3 | Beta flags (add `context-management`, make `oauth` conditional) | **P0** | ~15 lines |
| 4 | Billing header content source (first user msg) | **P1** | ~5 lines |
| 5 | Tool prefix `mcp_` → `mcp__` | **P1** | ~3 lines |
| 6 | Claude.ai authorize URL | **P2** | ~10 lines |
| 7 | Roles endpoint | **P3** | New feature |
| 8 | Dynamic beta assembly | **P2** | ~30 lines |
| 9 | New API endpoints | **P3** | Per-feature |
| 10 | Agent SDK prompt variants | **P3** | ~5 lines |
