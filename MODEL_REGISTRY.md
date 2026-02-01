# Model Registry

This document defines provider costs, model capabilities, and task assignment rules for the dialog model's automatic model selection system.

## Provider Pricing & Usage Policies

### Subscription-Based Providers (優先使用)

| Provider | Plan | Rate Limits | Cost Model |
|----------|------|-------------|------------|
| `opencode` | Subscription | Generous | Monthly subscription, no per-token cost |
| `anthropic` (OAuth) | Claude Pro/Max | Varies by tier | Monthly subscription |
| `openai` (OAuth/Codex) | ChatGPT Plus | ~80 msgs/3h (GPT-4) | Monthly subscription |
| `github-copilot` | Copilot subscription | Generous | Monthly subscription |
| `gemini-cli` | Google One AI Premium | Varies | Monthly subscription |

### API-Key Based Providers (備用)

| Provider | Pricing | Notes |
|----------|---------|-------|
| `anthropic` (API) | $3-15/M input, $15-75/M output | Per-token billing |
| `openai` (API) | $0.15-60/M input, $0.60-200/M output | Per-token billing |
| `google` | $0.075-7/M input, $0.30-21/M output | Per-token billing |
| `openrouter` | Varies by model | Aggregator, per-token |
| `deepseek` | $0.14-2.19/M tokens | Budget option |

## Model Capabilities Matrix

### Tier 1: Flagship Models (Complex reasoning, architecture, long context)

| Model | Provider | Context | Strengths | Limitations |
|-------|----------|---------|-----------|-------------|
| `claude-opus-4-5` | anthropic | 200K | Deep reasoning, nuanced analysis, creative writing | Slower, higher cost |
| `claude-sonnet-4` | anthropic | 200K | Balanced speed/quality, coding, analysis | - |
| `gpt-5` | openai | 128K | Advanced reasoning, multimodal | Rate limited |
| `o3-mini` | openai | 128K | Fast reasoning, good at math/code | - |
| `gemini-2.5-pro` | google | 1M | Huge context, multimodal | Slower |

### Tier 2: Workhorse Models (Daily tasks, moderate complexity)

| Model | Provider | Context | Strengths | Limitations |
|-------|----------|---------|-----------|-------------|
| `claude-3-5-sonnet` | anthropic | 200K | Fast, reliable coding | Older generation |
| `gpt-4o` | openai | 128K | Fast, good all-rounder | - |
| `gemini-2.0-flash` | google | 1M | Fast, large context | Less nuanced |

### Tier 3: Fast/Cheap Models (Simple tasks, high volume)

| Model | Provider | Context | Strengths | Limitations |
|-------|----------|---------|-----------|-------------|
| `claude-3-5-haiku` | anthropic | 200K | Fastest Claude, cheap | Limited reasoning |
| `gpt-4o-mini` | openai | 128K | Cheap, fast | Limited capability |
| `gemini-2.0-flash-lite` | google | 1M | Very fast | Basic tasks only |

## Task Assignment Rules

### Task Categories

```yaml
task_categories:
  architecture:
    description: "System design, refactoring, complex planning"
    preferred_tier: 1
    models: [claude-opus-4-5, gpt-5, gemini-2.5-pro]

  coding:
    description: "Writing, editing, debugging code"
    preferred_tier: 2
    models: [claude-sonnet-4, claude-3-5-sonnet, gpt-4o]

  review:
    description: "Code review, documentation review"
    preferred_tier: 2
    models: [claude-sonnet-4, gpt-4o, gemini-2.0-flash]

  simple_edit:
    description: "Simple file edits, formatting, small fixes"
    preferred_tier: 3
    models: [claude-3-5-haiku, gpt-4o-mini, gemini-2.0-flash-lite]

  search:
    description: "Code search, file exploration"
    preferred_tier: 3
    models: [claude-3-5-haiku, gpt-4o-mini]

  title_summary:
    description: "Generating titles, summaries"
    preferred_tier: 3
    models: [claude-3-5-haiku, gpt-4o-mini]
```

## Selection Priority Algorithm

When selecting a model vector `(provider, account, model)`:

1. **Check task type** → Determine preferred tier
2. **Filter by subscription** → Prioritize subscription accounts
3. **Check rate limits** → Exclude rate-limited vectors
4. **Check health scores** → Prefer healthy accounts (score > 50)
5. **Apply cost optimization**:
   - Subscription accounts: cost = 0
   - API accounts: cost = estimated token cost
6. **Select best available** using rotation3d strategy

## Rate Limit Recovery Times

| Reason | Backoff | Strategy |
|--------|---------|----------|
| `QUOTA_EXHAUSTED` | 1m → 5m → 30m → 2h | Exponential |
| `RATE_LIMIT_EXCEEDED` | 30s | Fixed |
| `MODEL_CAPACITY_EXHAUSTED` | 45s ± 15s | With jitter |
| `SERVER_ERROR` | 20s | Fixed |

## Model Equivalents (Fallback Mapping)

When a model is unavailable, fall back to equivalents:

```yaml
fallback_chains:
  claude-opus-4-5:
    - claude-sonnet-4
    - gpt-5
    - gemini-2.5-pro

  claude-sonnet-4:
    - claude-3-5-sonnet
    - gpt-4o
    - gemini-2.0-flash

  gpt-5:
    - gpt-4o
    - claude-sonnet-4
    - gemini-2.5-pro

  claude-3-5-haiku:
    - gpt-4o-mini
    - gemini-2.0-flash-lite
```

## Real-Time Status Integration

The dialog model should query `/api/rotation/status` to get:

```typescript
interface RotationStatus {
  accounts: Array<{
    id: string
    provider: string
    type: "subscription" | "api"
    healthScore: number
    isRateLimited: boolean
    rateLimitResetAt?: number
  }>

  models: Array<{
    provider: string
    model: string
    available: boolean
    waitTimeMs: number
  }>

  recommended: {
    dialog: ModelVector      // Best for dialog (main conversation)
    task: ModelVector        // Best for sub-agent tasks
    background: ModelVector  // Best for background tasks (titles, summaries)
  }
}
```

## Usage in AGENTS.md

Agents should reference this registry for model assignment:

```markdown
## Model Selection

For this agent, use the following selection criteria:
- Primary: subscription-based accounts (opencode, anthropic OAuth, openai OAuth)
- Fallback: API accounts with lowest cost
- Task tier: [1|2|3] based on agent complexity

The dialog model will automatically:
1. Query real-time rate limit status
2. Select optimal (provider, account, model) vector
3. Handle fallback on rate limit errors
4. Track health scores for future selection
```
