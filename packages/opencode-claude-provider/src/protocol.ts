/**
 * Protocol constants extracted from @anthropic-ai/claude-code@2.1.92
 *
 * Single file to update when official CLI upgrades.
 * Source of truth: plans/claude-provider/protocol-datasheet.md
 */
import { createHash } from "node:crypto"

// ---------------------------------------------------------------------------
// § 0.2  Core Constants
// ---------------------------------------------------------------------------

export const VERSION = "2.1.92"
export const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
export const ATTRIBUTION_SALT = "59cf53e54c78"
export const API_VERSION = "2023-06-01"
export const BASE_API_URL = "https://api.anthropic.com"

// ---------------------------------------------------------------------------
// § 0.3  OAuth Endpoints
// ---------------------------------------------------------------------------

export const OAUTH = {
  authorizeConsole: "https://platform.claude.com/oauth/authorize",
  authorizeClaude: "https://claude.com/cai/oauth/authorize",
  token: "https://platform.claude.com/v1/oauth/token",
  profile: "https://api.anthropic.com/api/oauth/profile",
  apiKey: "https://api.anthropic.com/api/oauth/claude_cli/create_api_key",
  roles: "https://api.anthropic.com/api/oauth/claude_cli/roles",
  redirectUri: "https://platform.claude.com/oauth/code/callback",
} as const

// ---------------------------------------------------------------------------
// § 0.4  OAuth Scopes
// ---------------------------------------------------------------------------

export const AUTHORIZE_SCOPES =
  "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload"

export const REFRESH_SCOPES = [
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
] as const

// ---------------------------------------------------------------------------
// § 0.5  Identity Strings
// ---------------------------------------------------------------------------

/** Standard interactive CLI mode */
export const IDENTITY_INTERACTIVE =
  "You are Claude Code, Anthropic's official CLI for Claude."

/** Non-interactive with appended system prompt (Agent SDK) */
export const IDENTITY_AGENT_SDK =
  "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK."

/** Pure standalone agent mode */
export const IDENTITY_PURE_AGENT =
  "You are a Claude agent, built on Anthropic's Claude Agent SDK."

/** Server-side validation set — only these three are accepted for subscription auth */
export const IDENTITY_VALIDATION_SET = new Set([
  IDENTITY_INTERACTIVE,
  IDENTITY_AGENT_SDK,
  IDENTITY_PURE_AGENT,
])

// ---------------------------------------------------------------------------
// § 0.6  Beta Flags
// ---------------------------------------------------------------------------

/** Minimum required betas — always included in every API request */
export const MINIMUM_BETAS = [
  "claude-code-20250219",
  "interleaved-thinking-2025-05-14",
  "context-management-2025-06-27",
] as const

export interface AssembleBetasOptions {
  /** Whether the auth is OAuth/subscription (not API key) */
  isOAuth: boolean
  /** Model ID, used for model-conditional betas */
  modelId?: string
  /** Whether fast mode is enabled */
  fastMode?: boolean
  /** Whether effort parameter is used */
  effort?: boolean
  /** Whether task budget is specified */
  taskBudget?: boolean
  /** Extra betas from ANTHROPIC_BETAS environment variable */
  envBetas?: string[]
}

/** 1M context-eligible model patterns */
const CONTEXT_1M_MODELS = [
  "claude-opus-4",
  "claude-sonnet-4-5",
  "claude-sonnet-4-6",
]

function supports1MContext(modelId: string): boolean {
  return CONTEXT_1M_MODELS.some((prefix) => modelId.startsWith(prefix))
}

function supportsThinking(modelId: string): boolean {
  // All current Claude models support thinking; disable via env
  return !process.env.DISABLE_INTERLEAVED_THINKING
}

function supportsFastMode(modelId: string): boolean {
  // Fast mode supported on most models — gated by feature flag
  return true
}

/**
 * Assemble beta flags dynamically per-request.
 * Ref: claude-code@2.1.92 gD1 + conditional assembly
 */
export function assembleBetas(options: AssembleBetasOptions): string[] {
  const betas: string[] = [...MINIMUM_BETAS]

  // Auth-conditional
  if (options.isOAuth) {
    betas.push("oauth-2025-04-20")
    betas.push("prompt-caching-scope-2026-01-05")
  }

  // Model-conditional
  if (options.modelId) {
    if (supportsThinking(options.modelId)) {
      // Already in MINIMUM_BETAS, but explicit for clarity
    }
    if (supports1MContext(options.modelId)) {
      betas.push("context-1m-2025-08-07")
    }
  }

  // Feature-conditional
  if (options.fastMode && options.modelId && supportsFastMode(options.modelId)) {
    betas.push("fast-mode-2026-02-01")
  }
  if (options.effort) {
    betas.push("effort-2025-11-24")
  }
  if (options.taskBudget) {
    betas.push("task-budgets-2026-03-13")
  }

  // Environment override
  if (options.envBetas) {
    betas.push(...options.envBetas)
  }

  // Deduplicate
  return [...new Set(betas)]
}

// ---------------------------------------------------------------------------
// § 0.7  Billing Header
// ---------------------------------------------------------------------------

/**
 * Recapitulates KA7 function from official cli.js:
 * sha256(salt + content[4,7,20] + version).slice(0,3)
 */
export function calculateAttributionHash(content: string): string {
  const indices = [4, 7, 20]
  const chars = indices.map((idx) => content[idx] || "0").join("")
  const input = `${ATTRIBUTION_SALT}${chars}${VERSION}`
  return createHash("sha256").update(input).digest("hex").slice(0, 3)
}

/**
 * Build the x-anthropic-billing-header value.
 * Also used as system prompt block[0] text.
 */
export function buildBillingHeader(
  content: string,
  entrypoint?: string,
): string {
  const hash = calculateAttributionHash(content)
  const ep = entrypoint || process.env.CLAUDE_CODE_ENTRYPOINT || "unknown"
  return `cc_version=${VERSION}.${hash}; cc_entrypoint=${ep}; cch=00000;`
}

// ---------------------------------------------------------------------------
// § 0.8  Tool Prefix
// ---------------------------------------------------------------------------

/** Double underscore format: mcp__{serverName}__{toolName} */
export const TOOL_PREFIX = "mcp__"

// ---------------------------------------------------------------------------
// § 0.9  Boundary Marker
// ---------------------------------------------------------------------------

/** Separates static (cacheable) from dynamic (per-session) system prompt sections */
export const BOUNDARY_MARKER = "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__"
