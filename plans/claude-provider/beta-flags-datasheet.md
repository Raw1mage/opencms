# Claude CLI Beta Flags Datasheet

> Source: `@anthropic-ai/claude-code@2.1.92` npm package
> Extraction date: 2026-04-07

---

## Beta Flag Architecture

2.1.92 assembles beta flags **dynamically per-request** based on model, auth type, platform, and feature flags. This replaces our current hardcoded approach.

### Three Tiers

| Tier | Set Name | Purpose |
|---|---|---|
| Minimum Required | `gD1` | Always included in every API request |
| SDK Betas | `BD1` | Used for SDK-level filtering (Vertex compatibility) |
| Conditional | Per-request | Added based on model/auth/feature checks |

---

## Tier 1: Minimum Required (`gD1`)

Always sent on every request.

| Beta Flag | Variable | Notes |
|---|---|---|
| `claude-code-20250219` | `JP8` | **Identity flag** — tells Anthropic this is a Claude Code request |
| `interleaved-thinking-2025-05-14` | `RJq` | Enables thinking interleaved with output |
| `context-management-2025-06-27` | `MP8` | API-side context management |

> **Delta from 2.1.39**: `context-management-2025-06-27` is new as a minimum required flag.
> **Delta from 2.1.39**: `oauth-2025-04-20` was previously in our required set but is now conditional.

---

## Tier 2: SDK Betas (`BD1`)

Used for SDK compatibility layer (Vertex/Bedrock filtering).

| Beta Flag | Variable | Notes |
|---|---|---|
| `interleaved-thinking-2025-05-14` | `RJq` | Overlap with gD1 |
| `context-1m-2025-08-07` | `Ti` | Enables 1M context window |
| `tool-search-tool-2025-10-19` | `CJq` | Tool search capability |

---

## Tier 3: Conditional Flags

### Authentication-dependent

| Beta Flag | Variable | Condition | Notes |
|---|---|---|---|
| `oauth-2025-04-20` | `fJ` | Only if OAuth auth (`g7()`) | Was hardcoded in 2.1.39 |
| `prompt-caching-scope-2026-01-05` | `QQ6` | Only if OAuth auth (`Y` = isOAuth) | Scoped prompt caching |

### Model-dependent

| Beta Flag | Variable | Condition | Notes |
|---|---|---|---|
| `interleaved-thinking-2025-05-14` | `RJq` | Only if model supports thinking (`IIq(q)`) AND `DISABLE_INTERLEAVED_THINKING` env not set | Also in gD1 minimum |
| `context-1m-2025-08-07` | `Ti` | Only if model supports 1M context (`aD1(q)`) | Opus 4, Opus 4.5, Opus 4.6, Sonnet 4.5v2, Sonnet 4.6 |
| `redact-thinking-2026-02-12` | `XP8` | OAuth + model supports thinking + not Max plan + `showThinkingSummaries !== true` | Redacts thinking content |
| `structured-outputs-2025-12-15` | `t86` | OAuth + model supports it (`GA6(q)`) + `tengu_tool_pear` feature flag | Structured JSON output |
| `effort-2025-11-24` | `ID1` | When effort parameter is used and model supports it (`tL(Y)`) | Effort/budget control |

### Platform-dependent

| Beta Flag | Variable | Condition | Notes |
|---|---|---|---|
| `web-search-2025-03-05` | `xD1` | Only for Vertex or Foundry platform | Web search capability |
| `advanced-tool-use-2025-11-20` | `SJq` | First-party / anthropicAws (NOT vertex/bedrock) | Advanced tool use |
| `tool-search-tool-2025-10-19` | `CJq` | Vertex or Bedrock platform (replaces `SJq`) | Tool search |
| `bedrock-2023-05-31` | `Mm9` | Bedrock platform | Bedrock API version |
| `vertex-2023-10-16` | `t7_` | Vertex platform | Vertex API version |

### Feature-dependent

| Beta Flag | Variable | Condition | Notes |
|---|---|---|---|
| `fast-mode-2026-02-01` | `mD1` | Fast mode enabled + model supports it (`NJ(O.model)`) | Fast streaming mode |
| `afk-mode-2026-01-31` | `g06` | AFK mode active + first-party auth | Away-from-keyboard autonomous |
| `task-budgets-2026-03-13` | `uD1` | Task budget specified in request | Budget control |
| `advisor-tool-2026-03-01` | `pD1` | When advisor tool is active | Advisory capability |
| `context-management-2025-06-27` | `MP8` | `USE_API_CONTEXT_MANAGEMENT` env OR model-specific check (`fq_`) + first-party auth | API context management |

### MCP / Remote

| Beta Flag | Variable | Condition | Notes |
|---|---|---|---|
| `mcp-servers-2025-12-04` | `EXz` | When Claude.ai MCP servers are connected | MCP server integration |
| `ccr-byoc-2025-07-29` | `Pnz` | Remote code sessions active | BYOC sessions |
| `ccr-triggers-2026-01-30` | `e_Y` | Remote triggers/scheduling active | Scheduled agents |
| `environments-2025-11-01` | `uCY` | Environment runner requests | Sandboxed environments |
| `skills-2025-10-02` | (inline) | Skills API calls | Skills marketplace |
| `files-api-2025-04-14` | (inline) | Files API calls | File upload/download |
| `compact-2026-01-12` | (inline) | Compaction requests | Context compaction |
| `mcp-client-2025-11-20` | (inline) | MCP client operations | MCP protocol |

---

## Environment Variable Overrides

| Env Var | Effect |
|---|---|
| `ANTHROPIC_BETAS` | Additional betas appended to every request |
| `DISABLE_INTERLEAVED_THINKING` | Suppresses `interleaved-thinking` beta |
| `USE_API_CONTEXT_MANAGEMENT` | Forces `context-management` beta |
| `CLAUDE_CODE_DISABLE_FAST_MODE` | Disables `fast-mode` beta |
| `CLAUDE_CODE_ENTRYPOINT` | Sets `cc_entrypoint` in billing header |

---

## Implementation Recommendation for OpenCode

### Phase 1 (Immediate): Update minimum required

```typescript
const MINIMUM_BETAS = [
  "claude-code-20250219",
  "interleaved-thinking-2025-05-14",
  "context-management-2025-06-27",
]
```

### Phase 2: Add auth-conditional betas

```typescript
if (isOAuth) {
  betas.push("oauth-2025-04-20")
  betas.push("prompt-caching-scope-2026-01-05")
}
```

### Phase 3: Add model-conditional betas

```typescript
if (supportsThinking(model)) betas.push("interleaved-thinking-2025-05-14")
if (supports1MContext(model)) betas.push("context-1m-2025-08-07")
if (isOAuth && supportsThinking(model) && !isMaxPlan) betas.push("redact-thinking-2026-02-12")
```

### Phase 4: Feature flags (as needed)

Add `fast-mode`, `task-budgets`, `effort` etc. as we implement those features.

---

## Complete Beta Assembly Pseudocode (from 2.1.92)

```
function assembleBetas(model, authType, platform, features):
  betas = [...gD1]  // minimum required

  if isOAuth(authType):
    betas.push("oauth-2025-04-20")

  if supportsThinking(model) && !DISABLE_INTERLEAVED_THINKING:
    betas.push("interleaved-thinking-2025-05-14")

  if isOAuth && supportsThinking(model) && !isMaxPlan && !showThinkingSummaries:
    betas.push("redact-thinking-2026-02-12")

  if USE_API_CONTEXT_MANAGEMENT || modelSupportsContextMgmt(model):
    if isFirstParty(platform):
      betas.push("context-management-2025-06-27")

  if isOAuth && supportsStructuredOutputs(model) && tengu_tool_pear:
    betas.push("structured-outputs-2025-12-15")

  if platform == "vertex" || platform == "foundry":
    betas.push("web-search-2025-03-05")

  if isOAuth:
    betas.push("prompt-caching-scope-2026-01-05")

  if ANTHROPIC_BETAS env:
    betas.push(...env.ANTHROPIC_BETAS.split(","))

  // Per-request additions (in main loop):
  if fastMode && modelSupportsFast(model):
    betas.push("fast-mode-2026-02-01")

  if afkMode && isFirstParty:
    betas.push("afk-mode-2026-01-31")

  if effortParam:
    betas.push("effort-2025-11-24")

  if taskBudget:
    betas.push("task-budgets-2026-03-13")

  return deduplicate(betas)
```
