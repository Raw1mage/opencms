# AI SDK Dependency Upgrade Report

Generated: 2026-02-11 (UTC)

Scope checked:
- `/home/pkcs12/opencode/package.json`
- `/home/pkcs12/opencode/packages/opencode/package.json`

Rules applied:
- Only **minor/patch** upgrades within the same major version.
- **Major upgrades ignored** by request.
- For `"ai": "catalog:"` entries, the effective version is from root workspace catalog: `ai@5.0.119`.

## Existing patterns / constraints in this repo

1. The workspace uses Bun catalog pinning in root `package.json` (`workspaces.catalog`) for at least `ai`.
2. `@ai-sdk/*` provider versions are duplicated as explicit pins in both package files (must stay in sync).
3. Any future actual upgrade PR should update both files consistently (and catalog where relevant).

## Upgrade matrix (minor/patch only)

| Dependency | Current | Latest same-major | Upgrade? | Notes / brief change summary | Reference |
|---|---:|---:|---|---|---|
| `ai` | 5.0.119 | **5.0.129** | Yes | 10 patch releases available (5.0.120→5.0.129). Latest notes: dependency bump to `@ai-sdk/gateway@2.0.35`. | Release: https://github.com/vercel/ai/releases/tag/ai%405.0.129 |
| `@ai-sdk/amazon-bedrock` | 3.0.74 | **3.0.78** | Yes | 4 patch releases available. Latest notes: updated dependency to `@ai-sdk/anthropic@2.0.61`. | Release: https://github.com/vercel/ai/releases/tag/%40ai-sdk%2Famazon-bedrock%403.0.78 |
| `@ai-sdk/anthropic` | 2.0.58 | **2.0.61** | Yes | 3 patch releases available. Latest notes: adds Anthropic **compaction** feature. | Release: https://github.com/vercel/ai/releases/tag/%40ai-sdk%2Fanthropic%402.0.61 |
| `@ai-sdk/azure` | 2.0.91 | 2.0.91 | No | Already latest in major 2. | npm: https://www.npmjs.com/package/@ai-sdk/azure?activeTab=versions |
| `@ai-sdk/cerebras` | 1.0.36 | 1.0.36 | No | Already latest in major 1. | npm: https://www.npmjs.com/package/@ai-sdk/cerebras?activeTab=versions |
| `@ai-sdk/cohere` | 2.0.22 | 2.0.22 | No | Already latest in major 2. | npm: https://www.npmjs.com/package/@ai-sdk/cohere?activeTab=versions |
| `@ai-sdk/deepinfra` | 1.0.33 | **1.0.35** | Yes | 2 patch releases available. Latest notes: fixes token usage calculation for Gemini/Gemma models. | Release: https://github.com/vercel/ai/releases/tag/%40ai-sdk%2Fdeepinfra%401.0.35 |
| `@ai-sdk/gateway` | 2.0.30 | **2.0.35** | Yes | 5 patch releases available. Latest notes: reports image-generation usage info in Gateway. | Release: https://github.com/vercel/ai/releases/tag/%40ai-sdk%2Fgateway%402.0.35 |
| `@ai-sdk/google` | 2.0.52 | 2.0.52 | No | Already latest in major 2. | npm: https://www.npmjs.com/package/@ai-sdk/google?activeTab=versions |
| `@ai-sdk/google-vertex` | 3.0.98 | **3.0.101** | Yes | 3 patch releases available. Latest notes: dependency bump to `@ai-sdk/anthropic@2.0.61`. | Release: https://github.com/vercel/ai/releases/tag/%40ai-sdk%2Fgoogle-vertex%403.0.101 |
| `@ai-sdk/groq` | 2.0.34 | 2.0.34 | No | Already latest in major 2. | npm: https://www.npmjs.com/package/@ai-sdk/groq?activeTab=versions |
| `@ai-sdk/mistral` | 2.0.27 | 2.0.27 | No | Already latest in major 2. | npm: https://www.npmjs.com/package/@ai-sdk/mistral?activeTab=versions |
| `@ai-sdk/openai` | 2.0.89 | 2.0.89 | No | Already latest in major 2. | npm: https://www.npmjs.com/package/@ai-sdk/openai?activeTab=versions |
| `@ai-sdk/openai-compatible` | 1.0.32 | 1.0.32 | No | Already latest in major 1. | npm: https://www.npmjs.com/package/@ai-sdk/openai-compatible?activeTab=versions |
| `@ai-sdk/perplexity` | 2.0.23 | 2.0.23 | No | Already latest in major 2. | npm: https://www.npmjs.com/package/@ai-sdk/perplexity?activeTab=versions |
| `@ai-sdk/provider` | 2.0.1 | 2.0.1 | No | Already latest in major 2. | npm: https://www.npmjs.com/package/@ai-sdk/provider?activeTab=versions |
| `@ai-sdk/provider-utils` | 3.0.20 | 3.0.20 | No | Already latest in major 3. | npm: https://www.npmjs.com/package/@ai-sdk/provider-utils?activeTab=versions |
| `@ai-sdk/togetherai` | 1.0.34 | 1.0.34 | No | Already latest in major 1. | npm: https://www.npmjs.com/package/@ai-sdk/togetherai?activeTab=versions |
| `@ai-sdk/vercel` | 1.0.33 | 1.0.33 | No | Already latest in major 1. | npm: https://www.npmjs.com/package/@ai-sdk/vercel?activeTab=versions |
| `@ai-sdk/xai` | 2.0.51 | **2.0.57** | Yes | 6 patch releases available. Latest notes: handles new reasoning text chunk parts in xAI responses. | Release: https://github.com/vercel/ai/releases/tag/%40ai-sdk%2Fxai%402.0.57 |
| `@openrouter/ai-sdk-provider` | 1.5.4 | 1.5.4 | No | Already latest in major 1. | npm: https://www.npmjs.com/package/@openrouter/ai-sdk-provider?activeTab=versions |
| `ai-gateway-provider` | 2.3.1 | 2.3.1 | No | Already latest in major 2. | npm: https://www.npmjs.com/package/ai-gateway-provider?activeTab=versions |
| `@gitlab/gitlab-ai-provider` | 3.5.0 | 3.5.0 | No | Already latest in major 3. | npm: https://www.npmjs.com/package/@gitlab/gitlab-ai-provider?activeTab=versions |

## Upgrade candidates only (quick list)

1. `ai`: 5.0.119 → 5.0.129
2. `@ai-sdk/amazon-bedrock`: 3.0.74 → 3.0.78
3. `@ai-sdk/anthropic`: 2.0.58 → 2.0.61
4. `@ai-sdk/deepinfra`: 1.0.33 → 1.0.35
5. `@ai-sdk/gateway`: 2.0.30 → 2.0.35
6. `@ai-sdk/google-vertex`: 3.0.98 → 3.0.101
7. `@ai-sdk/xai`: 2.0.51 → 2.0.57

## Notes on changelog quality

- `@ai-sdk/*` and `ai` release notes are centralized in **vercel/ai GitHub Releases**, with package-specific tags.
- For providers outside `vercel/ai` where no upgrade is available, npm versions pages are linked for traceability.
