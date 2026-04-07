# Tasks (v3)

> Architecture: Custom LanguageModelV2 implementation replacing @ai-sdk/anthropic
> Reference: Official `@anthropic-ai/claude-code@2.1.92`
> Principles: (1) Fingerprint fidelity (2) Zero SDK pollution (3) Zero-config plugin pack

---

## Phase 0: Protocol Constants (`protocol.ts`)

> 從 anthropic.ts 和 datasheets 中提取所有常數到獨立模組。
> 這是所有後續 phase 的基礎。

- [ ] 0.1 建立 `packages/opencode-claude-provider/src/protocol.ts`
- [ ] 0.2 搬移：VERSION, CLIENT_ID, ATTRIBUTION_SALT
- [ ] 0.3 搬移：OAUTH endpoints (authorize, token, profile, api-key, roles)
- [ ] 0.4 搬移：OAUTH scopes (authorize scope, refresh scope)
- [ ] 0.5 搬移：IDENTITY strings (3 variants + validation set)
- [ ] 0.6 搬移：MINIMUM_BETAS, assembleBetas() logic
- [ ] 0.7 搬移：billing header format + hash algorithm
- [ ] 0.8 搬移：TOOL_PREFIX = "mcp__"
- [ ] 0.9 搬移：BOUNDARY_MARKER = "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__"
- [ ] 0.10 建立 `models.ts`：model catalog (IDs, context, max_output, pricing)

## Phase 1: Format Converters (`convert.ts`)

> LMv2 ↔ Anthropic 格式轉換。參考但不依賴 @ai-sdk/anthropic。

### 1A: Request Converters (LMv2 → Anthropic)

- [ ] 1A.1 `convertPrompt(LMv2Prompt) → { messages, system }`
  - [ ] user message: text, image (base64 + url), file
  - [ ] assistant message: text, tool_use (with mcp__ prefix)
  - [ ] tool result: tool_result blocks
- [ ] 1A.2 `convertTools(LMv2FunctionTool[]) → Anthropic tools[]`
  - [ ] 加 mcp__ prefix
  - [ ] JSON schema → Anthropic input_schema
- [ ] 1A.3 `convertSystemBlocks(sections, cacheEnabled) → system[]`
  - [ ] Block 0: billing header (cache: null)
  - [ ] Block 1: identity (cache: org)
  - [ ] Block 2: static sections before boundary (cache: global)
  - [ ] Block 3+: dynamic sections after boundary (cache: null)
  - [ ] cache_control.scope + TTL logic from `cQ` function
- [ ] 1A.4 `convertThinkingConfig(providerOptions) → thinking params`

### 1B: Response Converters (Anthropic → LMv2)

- [ ] 1B.1 Map `message_start` → `response-metadata` StreamPart
- [ ] 1B.2 Map `content_block_start` → `text-start` | `reasoning-start` | `tool-call-start`
- [ ] 1B.3 Map `content_block_delta` → `text-delta` | `reasoning-delta` | `tool-call-delta`
- [ ] 1B.4 Map `content_block_stop` → corresponding stop parts
- [ ] 1B.5 Map `message_delta` → usage update + finish reason
- [ ] 1B.6 Map `message_stop` → `finish` StreamPart
- [ ] 1B.7 Strip mcp__ prefix from tool names in response events
- [ ] 1B.8 Extract usage (input_tokens, output_tokens, cache_read, cache_creation)

## Phase 2: HTTP Layer (`headers.ts` + `sse.ts`)

### 2A: Header Builder

- [ ] 2A.1 `buildHeaders(auth, model, content, options) → Headers`
  - [ ] Authorization: Bearer {token}
  - [ ] anthropic-version: 2023-06-01
  - [ ] Content-Type: application/json
  - [ ] User-Agent: claude-code/{VERSION}
  - [ ] anthropic-beta: (dynamic per-request assembly)
  - [ ] x-anthropic-billing-header: (hash from first user message)
  - [ ] x-organization-uuid: (if orgID)
- [ ] 2A.2 **從零建構，不繼承任何 init.headers** — whitelist 模式
- [ ] 2A.3 `assembleBetas(auth, model, features) → string`
  - [ ] Minimum: claude-code-20250219, interleaved-thinking, context-management
  - [ ] Auth-conditional: oauth, prompt-caching-scope
  - [ ] Model-conditional: context-1m, redact-thinking
  - [ ] Feature-conditional: fast-mode, effort, task-budgets
  - [ ] Env: ANTHROPIC_BETAS append
- [ ] 2A.4 `buildBillingHeader(content, version, entrypoint) → string`
  - [ ] Hash: sha256(salt + content[4,7,20] + version).slice(0,3)
  - [ ] Content source: first non-meta user message

### 2B: SSE Parser

- [ ] 2B.1 `parseAnthropicSSE(body: ReadableStream) → ReadableStream<LMv2StreamPart>`
- [ ] 2B.2 Line-based buffering (handle chunk boundary splits)
- [ ] 2B.3 Event type dispatch (event: + data: + blank line protocol)
- [ ] 2B.4 Error event handling
- [ ] 2B.5 Ping event handling (keep-alive)

## Phase 3: Auth (`auth.ts`)

> 從 anthropic.ts 提取 OAuth 邏輯，與 transport 完全分離。

- [ ] 3.1 `authorize(mode) → { url, verifier }`
- [ ] 3.2 `exchange(code, verifier) → { refresh, access, expires }`
- [ ] 3.3 `refreshToken(refreshToken, clientId) → { access, expires, refresh? }`
- [ ] 3.4 `fetchProfile(accessToken) → { email, orgID }`
- [ ] 3.5 Token refresh mutex（防併發 race）
- [ ] 3.6 Credential schema 與現有 anthropic.ts 相容（不破壞已存 tokens）

## Phase 4: LanguageModelV2 Provider (`provider.ts`)

> 組裝以上模組，實作 LanguageModelV2 interface。

- [ ] 4.1 `createClaudeCode(options) → { languageModel(modelId): LanguageModelV2 }`
- [ ] 4.2 實作 `doStream(options)`：
  - [ ] 4.2.1 取得 auth token（必要時 refresh）
  - [ ] 4.2.2 convertPrompt → messages + system
  - [ ] 4.2.3 convertTools → tools (with mcp__)
  - [ ] 4.2.4 convertSystemBlocks → system blocks (with cache_control)
  - [ ] 4.2.5 buildHeaders → all headers from scratch
  - [ ] 4.2.6 JSON.stringify body
  - [ ] 4.2.7 fetch(url, { method: POST, headers, body })
  - [ ] 4.2.8 parseAnthropicSSE → ReadableStream<LMv2StreamPart>
  - [ ] 4.2.9 Return { stream, response metadata }
- [ ] 4.3 實作 `doGenerate(options)`（同步版，呼叫 doStream 收集完整 response）
- [ ] 4.4 URL 建構：`https://api.anthropic.com/v1/messages?beta=true`
- [ ] 4.5 Error handling：HTTP 4xx/5xx → LanguageModelV2 error format

## Phase 5: Integration（接入 opencode host）

### 5A: Provider Registration

- [ ] 5A.1 修改 `provider/provider.ts`：claude-cli 用 `createClaudeCode()` 取代 `createAnthropic()`
- [ ] 5A.2 Plugin auth hook 只負責 OAuth flow（authorize + exchange + profile）
- [ ] 5A.3 Auth token 傳遞：plugin → provider factory → doStream
- [ ] 5A.4 Model catalog 由 `models.ts` 提供，移除 provider.ts 中的 hardcoded list

### 5B: 移除 @ai-sdk/anthropic 依賴（for claude-cli only）

- [ ] 5B.1 移除 `custom-loaders-def.ts` 中的 anthropic headers
- [ ] 5B.2 移除 `provider.ts` 中 claude-cli 的 `createAnthropic()` 呼叫
- [ ] 5B.3 確認其他 provider（直接用 API key 的 anthropic）仍可用 `@ai-sdk/anthropic`

### 5C: Host 硬編碼清除

- [ ] 5C.1 `provider/transform.ts`：移除 `isClaudeCode` 分支
- [ ] 5C.2 `session/llm.ts`：移除 `isClaudeCode` flag 傳遞
- [ ] 5C.3 `server/routes/rotation.ts`：移除 claude-cli priority 硬編碼
- [ ] 5C.4 `provider/default-model.ts`：移除 subscription priority 硬編碼
- [ ] 5C.5 `account/index.ts`：移除 PROVIDERS 常數中的 "claude-cli"
- [ ] 5C.6 CLI 3 files：移除 display mapping 硬編碼

### 5D: 舊碼清除

- [ ] 5D.1 刪除 `plugin/anthropic.ts`（被 provider package 取代）
- [ ] 5D.2 刪除 `plugin/claude-native.ts`（FFI wrapper 不再需要）
- [ ] 5D.3 從 `plugin/index.ts` 移除 claude-cli internal plugin 註冊
- [ ] 5D.4 移除 `custom-loaders-def.ts` 中的 anthropic 區塊

## Phase 6: Verification

- [ ] 6.1 Wire format 比對：抓取 real request，逐 byte 比對 official CLI
  - [ ] Headers 完整一致（無多餘、無缺少）
  - [ ] Body structure 一致（system blocks 順序、cache_control 位置）
  - [ ] URL 一致（?beta=true）
- [ ] 6.2 OAuth flow 驗證：subscription login + token refresh
- [ ] 6.3 Streaming 驗證：完整對話含 tool calls
- [ ] 6.4 Prompt caching 驗證：cache_read_input_tokens > 0
- [ ] 6.5 全域 grep：host 中無 `claude-cli` / `isClaudeCode`（plugin/ 除外）
- [ ] 6.6 回歸驗證：codex、copilot、gemini-cli 不受影響

## Phase 7: Package 封裝

- [ ] 7.1 建立 `packages/opencode-claude-provider/package.json`
- [ ] 7.2 Peer dependencies: `@ai-sdk/provider` (types only)
- [ ] 7.3 Export: `createClaudeCode` + auth methods
- [ ] 7.4 可作為 external npm package 獨立載入
- [ ] 7.5 Test suite 搬移並獨立運行

---

## Reference Documents

| Document | Purpose |
|---|---|
| `protocol-datasheet.md` | 完整協議規格 |
| `beta-flags-datasheet.md` | Beta flags 觸發條件 |
| `system-prompt-datasheet.md` | System prompt 結構 + cache 策略 |
| `diff-2.1.39-vs-2.1.92.md` | 版本差異 |
| `refs/claude-code-npm/cli.js` | Official 2.1.92 reference binary |

---

## Removed

~~v1: C11 native plugin~~ — 官方 CLI 是 JS
~~v2: Hook-based refactor~~ — SDK 仍會污染 headers/body
~~@ai-sdk/anthropic 依賴~~ — 整層替換為 native LMv2 impl
