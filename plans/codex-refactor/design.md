# Codex Plugin — Design

## Architecture Decision

**Pattern**: Follow `@opencode-ai/claude-provider` exactly — native `LanguageModelV2` implementation that bypasses `@ai-sdk/openai` entirely.

**Blueprint**: `packages/opencode-claude-provider/src/` (8 files, ~340 LOC for provider.ts)

## Package Structure

```
packages/opencode-codex-provider/
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts          — public exports
    ├── provider.ts       — CodexLanguageModel implements LanguageModelV2
    ├── protocol.ts       — constants: URLs, originator, beta headers
    ├── convert.ts        — AI SDK prompt → Responses API input/instructions
    ├── headers.ts        — build request headers (originator, window-id, etc.)
    ├── sse.ts            — Responses API SSE → LanguageModelV2StreamPart
    ├── auth.ts           — OAuth token types + refresh
    ├── models.ts         — model catalog + context limits
    ├── transport-ws.ts   — WebSocket transport (from codex-websocket.ts)
    ├── continuation.ts   — file-backed continuation state (WS delta)
    └── types.ts          — ResponsesApiRequest, ResponseEvent, etc.
```

## Key Design Decisions

### DD-1: `codex-tui` as originator

User confirmed. We send `originator: codex-tui` which is in the upstream first-party whitelist.

### DD-2: Native LanguageModelV2 (no AI SDK adapter)

CodexLanguageModel.doStream():
1. Convert AI SDK prompt → Responses API `instructions` + `input[]`
2. Build headers: originator, window-id, beta-features, installation-id
3. Choose transport (WS preferred, HTTP fallback)
4. If WS: compute delta, send via WebSocket, bridge events to SSE-like stream
5. If HTTP: POST to Responses API, parse SSE stream
6. Map Responses API events → LanguageModelV2StreamPart

### DD-3: Transport inside the provider, not plugin hooks

Unlike current implementation where transport is a fetch interceptor hack,
the new provider owns its transport directly:
- `doStream()` → decides WS or HTTP → dispatches → returns ReadableStream
- No fetch override needed
- Plugin hook only handles auth credential injection

### DD-4: client_metadata + window lineage

Every request carries:
- `client_metadata.x-codex-installation-id` = stable UUID
- Header `x-codex-window-id` = `{conversation_id}:{window_generation}`
- `prompt_cache_key` = conversation_id

### DD-5: Compaction → WS reset

After compaction (detected via provider metadata or explicit signal):
- `window_generation++`
- WS session invalidated (close + reconnect on next turn)
- Continuation cache cleared

### DD-6: Plugin integration stays thin

```typescript
// packages/opencode/src/plugin/codex.ts (reduced to ~100 lines)
export async function CodexAuthPlugin(input: PluginInput): Promise<Hooks> {
  return {
    auth: {
      async loader(getAuth, provider) {
        // OAuth token refresh only
        // Returns credentials for CodexLanguageModel
      }
    }
  }
}
```

```typescript
// packages/opencode/src/provider/custom-loaders-def.ts
"codex": async () => ({
  autoload: true,
  async getModel(_sdk, modelID, options) {
    const { createCodex } = await import("@opencode-ai/codex-provider/provider")
    const provider = createCodex({
      credentials: options,
      originator: "codex-tui",
      conversationId: options?.conversationId,
    })
    return provider.languageModel(modelID)
  },
  options: {},
}),
```

## Migration Plan

### Files to create
- `packages/opencode-codex-provider/` (entire new package)

### Files to modify
- `packages/opencode/src/provider/custom-loaders-def.ts` — replace codex loader
- `packages/opencode/src/provider/provider.ts` — remove inline codex CUSTOM_LOADER

### Files to delete
- `packages/opencode/src/plugin/codex.ts` — replaced by thin auth plugin
- `packages/opencode/src/plugin/codex-websocket.ts` — moved into provider
- `packages/opencode/src/plugin/codex-native.ts` — merged into provider

### Files to clean
- `packages/opencode/src/session/compaction.ts` — remove codex server compaction path
- `packages/opencode/src/session/llm.ts` — remove codex-specific metadata capture

## Comparison with claude-provider

| Aspect | claude-provider | codex-provider |
|---|---|---|
| API | Anthropic Messages | OpenAI Responses |
| Transport | HTTP only | WS (primary) + HTTP (fallback) |
| Auth | OAuth + API key | OAuth only (PKCE) |
| Identity | claude-cli originator | codex-tui originator |
| Continuation | None (stateless) | previous_response_id + input delta |
| Compaction | None (server) | context_management + WS reset |
| Extra files | 8 files | 11 files (+transport-ws, continuation, types) |
