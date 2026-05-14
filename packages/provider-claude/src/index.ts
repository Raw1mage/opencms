// Protocol constants
export {
  VERSION,
  CLIENT_ID,
  API_VERSION,
  BASE_API_URL,
  TOOL_PREFIX,
  BOUNDARY_MARKER,
  OAUTH,
  AUTHORIZE_SCOPES,
  REFRESH_SCOPES,
  IDENTITY_INTERACTIVE,
  IDENTITY_AGENT_SDK,
  IDENTITY_PURE_AGENT,
  IDENTITY_VALIDATION_SET,
  BETA_CLAUDE_CODE,
  BETA_OAUTH,
  BETA_CONTEXT_1M,
  BETA_INTERLEAVED_THINKING,
  BETA_REDACT_THINKING,
  BETA_CONTEXT_MANAGEMENT,
  BETA_PROMPT_CACHING_SCOPE,
  BETA_FAST_MODE,
  BETA_EFFORT,
  BETA_TASK_BUDGETS,
  isFirstPartyish,
  isHaikuModel,
  supports1MContext,
  supportsThinking,
  modelSupportsContextManagement,
  assembleBetas,
  calculateAttributionHash,
  buildBillingHeader,
} from "./protocol.js"
export type { AssembleBetasOptions, ProviderRoute } from "./protocol.js"

// Model catalog
export {
  MODEL_CATALOG,
  getMaxOutput,
  findModel,
  isKnownModel,
} from "./models.js"
export type { ClaudeModelSpec } from "./models.js"

// Format converters
export {
  convertPrompt,
  convertTools,
  convertSystemBlocks,
  stripToolPrefix,
} from "./convert.js"
export type {
  AnthropicMessage,
  AnthropicContentBlock,
  AnthropicSystemBlock,
  AnthropicTool,
  ConvertSystemOptions,
} from "./convert.js"

// HTTP headers
export { buildHeaders } from "./headers.js"
export type { BuildHeadersOptions } from "./headers.js"

// SSE parser
export { parseAnthropicSSE, mapFinishReason } from "./sse.js"

// Auth
export {
  authorize,
  exchange,
  refreshToken,
  refreshTokenWithMutex,
  fetchProfile,
  isClaudeCredentials,
} from "./auth.js"
export type { ClaudeCredentials, TokenSet, Profile } from "./auth.js"

// Provider (main entry)
export { createClaudeCode } from "./provider.js"
export type { ClaudeCodeProviderOptions } from "./provider.js"
