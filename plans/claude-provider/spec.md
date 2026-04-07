# Spec (v3)

> v1: C11 native plugin (abandoned)
> v2: Hook-based refactor (superseded)
> v3: Native LanguageModelV2 implementation
> Updated: 2026-04-07

## Purpose

以自製的 `LanguageModelV2` 實作取代 `@ai-sdk/anthropic`，達成：
1. Request fingerprint 與官方 `claude-code@2.1.92` 完全一致
2. HTTP 層零 SDK 污染（無中間層 header 注入、無 body re-serialize）
3. System prompt cache_control 精確對齊官方結構
4. 自包含 provider package，host 無硬編碼

---

## Requirement 1: Fingerprint Fidelity

The provider SHALL produce HTTP requests indistinguishable from official Claude CLI 2.1.92. **No intermediate layer shall modify headers or body between the provider and the wire.**

### Scenario: Headers built from scratch

- **GIVEN** the provider's `doStream()` is called
- **WHEN** headers are constructed
- **THEN** headers are built from an empty `Headers` object (not inheriting from `init.headers`)
- **AND** only official-spec headers are present on the wire
- **AND** no `anthropic-client`, `x-stainless-*`, or other SDK-injected headers exist

### Scenario: Body directly serialized

- **GIVEN** the provider's `doStream()` is called
- **WHEN** the request body is built
- **THEN** the provider converts `LanguageModelV2CallOptions` directly to Anthropic format
- **AND** `JSON.stringify` is called exactly once (no parse→modify→re-serialize)

### Scenario: Wire format matches official

- **GIVEN** a subscription-auth messages request
- **THEN** wire format matches protocol-datasheet.md exactly:
  - `User-Agent: claude-code/2.1.92`
  - `anthropic-version: 2023-06-01`
  - `anthropic-beta: claude-code-20250219,interleaved-thinking-2025-05-14,context-management-2025-06-27[,oauth-2025-04-20,prompt-caching-scope-2026-01-05]`
  - `x-anthropic-billing-header: cc_version=2.1.92.{hash}; cc_entrypoint={ep}; cch=00000;`
  - URL: `https://api.anthropic.com/v1/messages?beta=true`
  - System block[0] = billing header text (no cache)
  - System block[1] = identity string (cache: org)

---

## Requirement 2: AI SDK Layer Separation

The provider SHALL replace `@ai-sdk/anthropic` while preserving `ai` core orchestration.

### Scenario: streamText integration

- **GIVEN** `streamText()` is called with the provider's model
- **WHEN** the orchestration layer invokes `model.doStream()`
- **THEN** the provider handles the full HTTP lifecycle internally
- **AND** `streamText()` receives `ReadableStream<LanguageModelV2StreamPart>` without knowing the transport

### Scenario: No @ai-sdk/anthropic in claude-cli path

- **GIVEN** a claude-cli provider is active
- **WHEN** tracing the call stack from `streamText()` to HTTP
- **THEN** `@ai-sdk/anthropic` is NOT in the call stack
- **AND** only `ai` (core) and `@ai-sdk/provider` (types) are used

### Scenario: Other providers unaffected

- **GIVEN** a non-claude-cli provider (codex, copilot, google-api)
- **WHEN** it uses `@ai-sdk/anthropic` or other SDK providers
- **THEN** its behavior is unchanged

---

## Requirement 3: System Prompt Cache Alignment

The provider SHALL produce system prompt blocks with `cache_control` matching official structure (see system-prompt-datasheet.md).

### Scenario: Boundary-based caching

- **GIVEN** prompt sections include static and dynamic content
- **WHEN** system blocks are generated
- **THEN** blocks before `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__` have `cache_control: { type: "ephemeral", scope: "global" }`
- **AND** blocks after boundary have no `cache_control`
- **AND** identity block has `cache_control: { type: "ephemeral", scope: "org" }` (not global)
- **AND** billing header block has no `cache_control`

### Scenario: Cache hit verification

- **GIVEN** a multi-turn conversation with stable static sections
- **WHEN** the second turn is sent
- **THEN** `cache_read_input_tokens > 0` in the response usage

---

## Requirement 4: Host Decoupling

NO file in host (`packages/opencode/src/`) outside of the provider package SHALL contain claude-cli branching logic.

### Scenario: No isClaudeCode flag

- **GIVEN** the provider is integrated
- **WHEN** grepping host code for `isClaudeCode` or `providerId === "claude-cli"`
- **THEN** zero matches outside the provider package

### Scenario: Provider self-registration

- **GIVEN** the provider package is loaded
- **WHEN** host queries available models
- **THEN** model catalog comes from the provider package, not from `provider.ts` hardcoded lists

---

## Architecture Constraints

1. **LanguageModelV2 contract**: Provider MUST implement `doStream()` and `doGenerate()` per `@ai-sdk/provider` spec.
2. **Auth separation**: OAuth PKCE flow and token refresh MUST be separate from transport (`doStream`). Token is passed as config, not obtained inside fetch.
3. **Single serialize**: Request body MUST be serialized exactly once — no parse→modify→re-serialize chain.
4. **Whitelist headers**: Headers MUST be built from empty, not inherited from any upstream layer.
5. **Backward compat**: Existing OAuth credentials (refresh tokens in accounts.json) MUST continue to work.
6. **No custom-loaders**: Provider MUST NOT use opencode's custom-loaders-def.ts pipeline. It manages its own SDK instance or raw fetch.
