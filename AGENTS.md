- To regenerate the JavaScript SDK, run `./packages/sdk/js/script/build.ts`.
- ALWAYS USE PARALLEL TOOLS WHEN APPLICABLE.
- The default branch in this repo is `dev`.
- Prefer automation: execute requested actions without confirmation unless blocked by missing info or safety/irreversibility.
- Bun is installed at `/home/pkcs12/.bun/bin/bun`.

## Documentation / Planning

- 規劃與需求請直接更新 `packages/opencode/DIARY.md`（依日期排序、繁體中文）。
- 所有開發紀錄統一改為 DIARY。

## Style Guide

### General Principles

- Keep things in one function unless composable or reusable
- Avoid `try`/`catch` where possible
- Avoid using the `any` type
- Prefer single word variable names where possible
- Use Bun APIs when possible, like `Bun.file()`
- Rely on type inference when possible; avoid explicit type annotations or interfaces unless necessary for exports or clarity

### Naming

Prefer single word names for variables and functions. Only use multiple words if necessary.

```ts
// Good
const foo = 1
function journal(dir: string) {}

// Bad
const fooBar = 1
function prepareJournal(dir: string) {}
```

Reduce total variable count by inlining when a value is only used once.

```ts
// Good
const journal = await Bun.file(path.join(dir, "journal.json")).json()

// Bad
const journalPath = path.join(dir, "journal.json")
const journal = await Bun.file(journalPath).json()
```

### Destructuring

Avoid unnecessary destructuring. Use dot notation to preserve context.

```ts
// Good
obj.a
obj.b

// Bad
const { a, b } = obj
```

### Variables

Prefer `const` over `let`. Use ternaries or early returns instead of reassignment.

```ts
// Good
const foo = condition ? 1 : 2

// Bad
let foo
if (condition) foo = 1
else foo = 2
```

### Control Flow

Avoid `else` statements. Prefer early returns.

```ts
// Good
function foo() {
  if (condition) return 1
  return 2
}

// Bad
function foo() {
  if (condition) return 1
  else return 2
}
```

### Schema Definitions (Drizzle)

Use snake_case for field names so column names don't need to be redefined as strings.

```ts
// Good
const table = sqliteTable("session", {
  id: text().primaryKey(),
  project_id: text().notNull(),
  created_at: integer().notNull(),
})

// Bad
const table = sqliteTable("session", {
  id: text("id").primaryKey(),
  projectID: text("project_id").notNull(),
  createdAt: integer("created_at").notNull(),
})
```

## Testing

You MUST avoid using `mocks` as much as possible.
Tests MUST test actual implementation, do not duplicate logic into a test.

---

## Agent/Subagent Model Selection Policy

Agents and subagents should select models from **Favorites** as the primary pool for automatic rotation. The model selection considers both availability (rate limits) and cost efficiency based on billing type.

### Billing Model Types

| Type                  | Calculation         | Best For                                         | Examples                          |
| --------------------- | ------------------- | ------------------------------------------------ | --------------------------------- |
| **Token-based**       | Per-token usage     | Trivial/small tasks (low token count = low cost) | OpenAI API (`gpt-5.1-codex-mini`) |
| **Subscription**      | Per-request quota   | Large/complex tasks (more value per message)     | ChatGPT Plus, OpenCode            |
| **Work-based**        | Per-task complexity | Trivial tasks (simple = low quota burn)          | Antigravity (Google AI Pro/Ultra) |
| **Quota-based (RPD)** | Per-request limit   | Moderate/Complex tasks (preserve daily limit)    | Google API (Free Tier)            |

> ⚠️ **RPD 計次型計費**: Google API Free Tier 每個 request 消耗 1 RPD，不論 token 多少。一句話和一整頁的 prompt 消耗相同。**不應用於瑣碎任務**。
>
> **Note on Antigravity**: Charges by "work done". Ideal for quick fixes.
>
> **Note on Anthropic**: Temporarily PAUSED due to policy restrictions on third-party subscription reuse.

### Available Models

#### OpenAI (Current Options)

| Model                | Billing      | Best For                                  |
| -------------------- | ------------ | ----------------------------------------- |
| `gpt-5.2-codex`      | subscription | Latest frontier agentic coding            |
| `gpt-5.2`            | subscription | Latest frontier model                     |
| `gpt-5.1-codex-max`  | subscription | Deep and fast reasoning                   |
| `gpt-5.1-codex-mini` | **token**    | **Trivial tasks (PRIMARY)** - cheap, fast |

#### Google API Free Tier (RPD 計次型)

| Model                 | RPM | TPM  | RPD       | 適用場景 |
| --------------------- | --- | ---- | --------- | -------- |
| Gemini 2.5 Flash-Lite | 15  | 250K | **1,000** | 中等任務 |
| Gemini 2.5 Flash      | 10  | 250K | 250       | 一般開發 |
| Gemini 2.5 Pro        | 5   | 250K | 100       | 複雜推理 |
| Gemini 3 Pro Preview  | 10  | 250K | 100       | 最新功能 |

> ⚠️ **不要用 Google API 做瑣碎任務！**
>
> - ❌ Title generation, summaries, yes/no → 用 `gpt-5.1-codex-mini`
> - ❌ Host/Orchestrator 互動 → 用 `gpt-5.1-codex-mini`
> - ✅ Coding, review, planning → 可以用 Google API

#### Antigravity (Work-based)

| Tier               | Reset   | Best For      |
| ------------------ | ------- | ------------- |
| Free               | Weekly  | Light usage   |
| AI Pro ($20/mo)    | 5 hours | Regular usage |
| AI Ultra ($250/mo) | 5 hours | Heavy usage   |

Models: Gemini 3 Pro/Flash, Claude Opus 4.5, Claude Sonnet 4.5, GPT-OSS 120B

### Task-to-Model Matching (Multi-Factor Scoring)

We select models based on a weighted score: **Domain (40%) + Capability (30%) + Cost (30%)**.

```opencode-model-scoring
{
  "weights": {
    "domain": 0.4,
    "capability": 0.3,
    "cost": 0.3
  },
  "domain": {
    "coding": {
      "openai/gpt-5.2-codex": 100,
      "anthropic/claude-opus-4-5": 90,
      "google/gemini-2.5-pro": 85,
      "google/gemini-3-pro-preview": 80,
      "anthropic/claude-sonnet-4-5": 95
    },
    "review": {
      "openai/gpt-5.2-codex": 90,
      "anthropic/claude-opus-4-5": 95,
      "google/gemini-2.5-pro": 85,
      "google/gemini-3-pro-preview": 80,
      "anthropic/claude-sonnet-4-5": 90
    },
    "reasoning": {
      "openai/gpt-5.2-codex": 85,
      "anthropic/claude-opus-4-5": 95,
      "google/gemini-2.5-pro": 90,
      "google/gemini-3-pro-preview": 95,
      "anthropic/claude-sonnet-4-5": 90
    },
    "testing": {
      "openai/gpt-5.2-codex": 95,
      "anthropic/claude-opus-4-5": 90,
      "google/gemini-2.5-pro": 85,
      "google/gemini-3-pro-preview": 80,
      "anthropic/claude-sonnet-4-5": 90
    },
    "docs": {
      "openai/gpt-5.2-codex": 80,
      "anthropic/claude-opus-4-5": 100,
      "google/gemini-2.5-pro": 85,
      "google/gemini-3-pro-preview": 80,
      "anthropic/claude-sonnet-4-5": 95
    }
  },
  "capability": {
    "openai/gpt-5.2-codex": 95,
    "anthropic/claude-opus-4-5": 98,
    "google/gemini-2.5-pro": 90,
    "google/gemini-3-pro-preview": 95,
    "anthropic/claude-sonnet-4-5": 92
  },
  "cost": {
    "google/gemini-2.5-pro": 90,
    "google/gemini-3-pro-preview": 80,
    "anthropic/claude-sonnet-4-5": 70,
    "openai/gpt-5.2-codex": 60,
    "anthropic/claude-opus-4-5": 50
  }
}
```

#### 1. Domain Score (40%)

| Domain        | GPT-5.2-Codex | Claude-Opus-4.5 | Gemini-2.5-Pro | Gemini-3-Pro | Claude-Sonnet-4.5 |
| :------------ | :-----------: | :-------------: | :------------: | :----------: | :---------------: |
| **Coding**    |      100      |       90        |       85       |      80      |        95         |
| **Review**    |      90       |       95        |       85       |      80      |        90         |
| **Reasoning** |      85       |       95        |       90       |      95      |        90         |
| **Docs**      |      80       |       100       |       85       |      80      |        95         |

#### 2. Capability Score (30%)

_Based on benchmarks, context window, and instruction following._

| Model                 | Score | Notes                                 |
| :-------------------- | :---: | :------------------------------------ |
| **GPT-5.2-Codex**     |  95   | Best coding, standard context         |
| **Claude-Opus-4.5**   |  98   | Best nuance/instruction, 200k context |
| **Gemini-2.5-Pro**    |  90   | 2M context, good reasoning            |
| **Gemini-3-Pro**      |  95   | Deep reasoning/thinking               |
| **Claude-Sonnet-4.5** |  92   | Balanced speed/intelligence           |

#### 3. Cost Score (30%)

_Higher score = Lower cost / Better value._

| Model                 | Score | Notes                          |
| :-------------------- | :---: | :----------------------------- |
| **Gemini-2.5-Pro**    |  90   | Free tier available / Low cost |
| **Gemini-3-Pro**      |  80   | Moderate cost                  |
| **Claude-Sonnet-4.5** |  70   | Mid-tier pricing               |
| **GPT-5.2-Codex**     |  60   | High value but expensive       |
| **Claude-Opus-4.5**   |  50   | Most expensive                 |

#### Selection Logic

1. **Rank**: Calculate weighted score for all models.
2. **Filter**: Remove models currently rate-limited or unhealthy (via Rotation3D).
3. **Select**: Pick the highest-scoring available model.
4. **Fallback**: If execution fails, pick the next model in the ranked list.

### Provider Priority

**Complex tasks** (high token count):

1. Subscription: `opencode`, `openai-oauth`, `github-copilot`
2. High-quota: `gemini-cli`
3. API fallback: `openai-api`, `google-api` (Pro/Flash)

**Trivial tasks** (high frequency):

1. **Token-based: `gpt-5.1-codex-mini`** ← PRIMARY
2. Work-based: `antigravity`
3. DO NOT use Google API (wastes RPD)

### Subagent Policies

```yaml
subagent_policies:
  host:
    description: "Orchestrator, user interaction"
    model: "gpt-5.1-codex-mini"
    billing: token-based

  explore:
    description: "Codebase exploration"
    model: "gpt-5.1-codex-mini"
    billing: token-based

  plan:
    description: "Architecture planning"
    models: [gpt-5.2-codex, gemini-2.5-pro]
    billing: subscription

  bash:
    description: "Command execution"
    model: "gpt-5.1-codex-mini"
    billing: token-based

  general:
    description: "Multi-step tasks"
    models: [gpt-5.2-codex, gpt-5.2]
    billing: subscription
```

### Rate Limit Recovery

| Reason                     | Backoff            |
| -------------------------- | ------------------ |
| `QUOTA_EXHAUSTED`          | 1m → 5m → 30m → 2h |
| `RATE_LIMIT_EXCEEDED`      | 30s                |
| `MODEL_CAPACITY_EXHAUSTED` | 45s ± 15s          |
| `SERVER_ERROR`             | 20s                |

### Fallback Chains

```yaml
fallback:
  gpt-5.2-codex: [gpt-5.2, gpt-5.1-codex-max, gemini-2.5-pro]
  gpt-5.2: [gpt-5.2-codex, gemini-2.5-pro]
  gemini-2.5-pro: [gpt-5.2-codex, gemini-2.5-flash]
  gpt-5.1-codex-mini: [gemini-2.5-flash-lite] # Last resort only
```
