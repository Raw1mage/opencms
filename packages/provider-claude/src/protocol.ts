/**
 * Protocol constants extracted from @anthropic-ai/claude-code@2.1.186
 *
 * Single file to update when official CLI upgrades.
 * Source of truth: specs/claude-cli/cli-reversed-spec/chapters/protocol-datasheets.md
 * Verify with: bun packages/provider-claude/scripts/sync-from-cli.ts
 *
 * 2026-06-10: realigned 2.1.169 → 2.1.170 for the Mythos-class launch
 * (Claude Fable 5 / Mythos 5). The mid-conversation-system gate (upstream O98)
 * widened from opus-4-8-only to {opus-4-8, fable-5, mythos-5}; fable-5/mythos-5
 * join the 1M-context and 64000 max-output tiers. See docs/events.
 *
 * 2026-06-16: bumped 2.1.170 → 2.1.178 (fingerprint only). sync-from-cli
 * drift-check against 2.1.178 = 53/53 PASS except the VERSION string itself;
 * all scopes / OAuth hosts / UA / betas / model catalog / max-output unchanged.
 * Confirmed claude-opus-4-8 is officially "Opus 4.8 (1M context)" — our 1M
 * treatment matches upstream.
 *
 * 2026-06-24: bumped 2.1.178 → 2.1.186 (fingerprint only). Re-extracted from
 * the 2.1.186 native ELF (BUILD_TIME 2026-06-22T16:43:00Z, GIT_SHA 6a56aff5).
 * All wire constants identical: CLIENT_ID, ATTRIBUTION_SALT, scopes, OAuth
 * hosts, OAUTH_USER_AGENT (axios/1.15.2), beta registry (28, stable), billing
 * shape, client-platform map, opus-4-8 64000/128000 tier. Upstream's only
 * registry drift (fallback_credit -06-09 → -06-01) is statsig-gated and not in
 * assembleBetas. See specs/claude-cli/cli-reversed-spec §13.
 */
import { createHash } from "node:crypto"
import { normalizeModelId } from "./models.js"

// ---------------------------------------------------------------------------
// § 0.2  Core Constants
// ---------------------------------------------------------------------------

export const VERSION = "2.1.186"
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

/**
 * Authorize scopes — used by BOTH the subscription and console flows.
 *
 * Upstream `bx8` = union of console scopes (`$3q` = [org:create_api_key,
 * user:profile]) and claude.ai scopes (`zR$`, see below). The official
 * authorize URL builder sends this exact set regardless of `loginWithClaudeAi`
 * (only `inferenceOnly` narrows it to `[user:inference]`). Subscription
 * accounts simply can't act on `org:create_api_key`; the authorization server
 * grants the subset it can. (Historically we stripped `org:create_api_key`
 * from the subscription authorize believing it caused "授權碼無效" — that was
 * actually the wrong-authorize-host bug; once the host is correct, the union
 * matches upstream and works. 2026-05-30.)
 */
export const AUTHORIZE_SCOPES =
  "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload"

/**
 * Refresh-grant scopes — upstream `zR$`. The `refresh_token` grant uses the
 * narrower set WITHOUT `org:create_api_key`: a subscription account cannot
 * grant org-level key creation, so including it in a refresh yields
 * `invalid_scope`. Also equals the scope set carried in a real `claudeAiOauth`
 * credential. (Name kept as SUBSCRIPTION_SCOPES for back-compat; semantically
 * these are the refresh scopes — authorize uses AUTHORIZE_SCOPES above.)
 */
export const SUBSCRIPTION_SCOPES = [
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
] as const

export const REFRESH_SCOPES = SUBSCRIPTION_SCOPES

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
// § 0.6  Beta Flag Constants
// ---------------------------------------------------------------------------
// Each beta flag string upstream cli.js declares as a top-level const at offset
// ~2439173. We re-export them named so call sites grep cleanly.

export const BETA_CLAUDE_CODE = "claude-code-20250219" // upstream: mZ8
export const BETA_OAUTH = "oauth-2025-04-20" // upstream: eJ
export const BETA_CONTEXT_1M = "context-1m-2025-08-07" // upstream: Zo
export const BETA_INTERLEAVED_THINKING = "interleaved-thinking-2025-05-14" // upstream: fZq
export const BETA_REDACT_THINKING = "redact-thinking-2026-02-12" // upstream: pZ8 (NEW per DD-5)
export const BETA_CONTEXT_MANAGEMENT = "context-management-2025-06-27" // upstream: BZ8
export const BETA_PROMPT_CACHING_SCOPE = "prompt-caching-scope-2026-01-05" // upstream: On6
export const BETA_FAST_MODE = "fast-mode-2026-02-01" // upstream: lv1
export const BETA_EFFORT = "effort-2025-11-24" // upstream: dv1
export const BETA_TASK_BUDGETS = "task-budgets-2026-03-13" // upstream: cv1
export const BETA_EXTENDED_CACHE_TTL = "extended-cache-ttl-2025-04-11" // upstream: IWH (extended_cache_ttl)
// upstream: $a. WW6 pushes it when O98(model) is true. O98 returns true ONLY for
// claude-opus-4-8 among current models (all others explicitly false), off under
// HIPAA / explicit disable. opencode emits it for opus-4-8 to match the real CLI
// fingerprint on its primary model (see specs/claude-cli/cli-reversed-spec/
// chapters/betas-and-fallback-teardown-2.1.169.md §5).
export const BETA_MID_CONVERSATION_SYSTEM = "mid-conversation-system-2026-04-07"

// Extended prompt-cache TTL — single source of truth (issues/enhancement_20260601_claude_1h_cache_ttl.md).
// Official claude-cli applies "1h" to cache_control breakpoints AND emits the
// extended-cache-ttl beta TOGETHER (cli.js: if(ttl==="1h"&&ET()) push IWH). We
// bind BOTH to this one const so convert.ts (sets cache_control.ttl) and
// assembleBetas (emits the beta) can never drift. undefined → Anthropic default
// 5-min ephemeral. 1h costs 2x on cache_write but survives idle (read 0.1x) —
// a net win for the idle-heavy usage this provider sees. Flip to undefined to
// revert to 5-min; both the ttl and the beta header drop together.
export const CLAUDE_CACHE_TTL: "1h" | undefined = "1h"

// RESERVED slots — present in upstream ZR1 push order but not emitted by opencode (DD-6):
//   structured-outputs-2025-12-15  (upstream t76; tengu_tool_pear feature flag)
//   web-search-2025-03-05          (upstream Qv1; vertex/foundry only)

// ---------------------------------------------------------------------------
// § 0.6.1  Provider Route (upstream pq() return values)
// ---------------------------------------------------------------------------
// upstream $Q() at cli.js@2317694 defines the "first-party-ish" set as
// {firstParty, anthropicAws, foundry, mantle}. We carry the full enum so unit
// tests can exercise non-firstParty branches even though opencode runtime only
// uses firstParty (see DD-4, DD-14 in design.md).

export type ProviderRoute =
  | "firstParty"
  | "anthropicAws"
  | "bedrock"
  | "vertex"
  | "foundry"
  | "mantle"

const FIRST_PARTYISH = new Set<ProviderRoute>([
  "firstParty",
  "anthropicAws",
  "foundry",
  "mantle",
])

/** upstream $Q() at cli.js@2317694 */
export function isFirstPartyish(provider: ProviderRoute): boolean {
  return FIRST_PARTYISH.has(provider)
}

// ---------------------------------------------------------------------------
// § 0.6.2  Model predicates
// ---------------------------------------------------------------------------

/** upstream: o5(q).includes("haiku") at cli.js ZR1@3482150 */
export function isHaikuModel(modelId: string): boolean {
  return modelId.toLowerCase().includes("haiku")
}

/** 1M context-eligible model patterns. upstream CONTEXT_1M list. */
const CONTEXT_1M_MODELS = [
  "claude-fable-5",
  "claude-mythos-5",
  "claude-opus-4",
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-sonnet-4-5",
  "claude-sonnet-4-6",
]

/** upstream: DP(q) — prefix match against 1M-context list */
export function supports1MContext(modelId: string): boolean {
  return CONTEXT_1M_MODELS.some((prefix) => modelId.startsWith(prefix))
}

/** upstream: ggq(q) — all current claude-* models support thinking; gated by env */
export function supportsThinking(modelId: string): boolean {
  // The env check belongs at the call site (provider.ts), not here. Keep
  // signature for drop-in compatibility with the legacy assembler — Phase 2
  // will call it after the env check is moved up.
  void modelId
  return !process.env.DISABLE_INTERLEAVED_THINKING
}

/**
 * upstream: iO_(q) at cli.js@3480483
 *   provider==="foundry"             → true
 *   $Q(provider) (firstPartyish)     → !modelId.startsWith("claude-3-")
 *   else                             → contains opus-4 || sonnet-4 || haiku-4
 */
export function modelSupportsContextManagement(
  modelId: string,
  provider: ProviderRoute,
): boolean {
  if (provider === "foundry") return true
  const m = modelId.toLowerCase()
  if (isFirstPartyish(provider)) return !m.startsWith("claude-3-")
  return (
    m.includes("claude-opus-4") ||
    m.includes("claude-sonnet-4") ||
    m.includes("claude-haiku-4")
  )
}

function supportsFastMode(modelId: string): boolean {
  // Fast mode supported on most models — gated by feature flag
  void modelId
  return true
}

/**
 * upstream O98 mid_conversation_system gate, narrowed to its model branch.
 * O98 enumerates every other current model (claude-3-*, opus-4-0/4-1/4-5/4-6/4-7,
 * sonnet-4-0/4-5/4-6, haiku-4-5) → false and returns true ONLY for the Mythos-class
 * top tier: {opus-4-8, fable-5, mythos-5} (2.1.170 widened this from opus-4-8-only;
 * opus-4-7 deliberately remains false). normalizeModelId strips date / [1m] / -vN /
 * -fast / -latest / region prefixes so every alias resolves here.
 */
const MID_CONVERSATION_SYSTEM_MODELS = new Set([
  "claude-opus-4-8",
  "claude-fable-5",
  "claude-mythos-5",
])

export function modelEmitsMidConversationSystem(modelId: string): boolean {
  return MID_CONVERSATION_SYSTEM_MODELS.has(normalizeModelId(modelId))
}

// ---------------------------------------------------------------------------
// § 0.6.3  AssembleBetasOptions
// ---------------------------------------------------------------------------

export interface AssembleBetasOptions {
  /** Whether the auth is OAuth/subscription (not API key). upstream: i7() */
  isOAuth: boolean
  /** Model ID, used for model-conditional betas */
  modelId?: string
  /** Whether fast mode is enabled */
  fastMode?: boolean
  /** Whether effort parameter is used */
  effort?: boolean
  /** Whether task budget is specified */
  taskBudget?: boolean
  /** Emit extended-cache-ttl beta — paired with cache_control ttl:"1h". upstream: IWH */
  extendedCacheTtl?: boolean
  /** Extra betas from ANTHROPIC_BETAS environment variable */
  envBetas?: string[]
  /** Routing target. Default firstParty. upstream: pq() */
  provider?: ProviderRoute
  /** Suppresses redact-thinking. upstream: v7().showThinkingSummaries */
  showThinkingSummaries?: boolean
  /** Resolved from CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS at the call site */
  disableExperimentalBetas?: boolean
  /** Resolved from DISABLE_INTERLEAVED_THINKING at the call site */
  disableInterleavedThinking?: boolean
  /** True iff running in interactive TTY. opencode daemon → false. upstream: !I7() */
  isInteractive?: boolean
  /** HIPAA mode — disables mid-conversation-system (upstream O98 first branch). */
  hipaa?: boolean
  /**
   * Explicit override for mid-conversation-system. `false` force-disables even on
   * opus-4-8 (mirrors upstream O98's per-request override). Default undefined →
   * the model gate decides.
   */
  midConversationSystem?: boolean
}

// ---------------------------------------------------------------------------
// § 0.6.4  assembleBetas — mirrors upstream ZR1 (cli.js@3482150)
// ---------------------------------------------------------------------------
// Push order is structural (DD-7). Each step independently consults its gate
// so the resulting array's order is byte-identical to claude-code 2.1.112's
// ZR1 output for the same (model × auth × provider × env) combination.
//
// Upstream reference (decoded from minified cli.js):
//   ZR1 = (q) => {
//     let isHaiku = o5(q).includes("haiku")
//     let provider = pq()
//     let Y = ja()                          // = isFirstPartyish(provider) && !disableExperimentalBetas
//     1. if (!isHaiku)         push mZ8    // claude-code-20250219
//     2. if (i7())             push eJ     // oauth-2025-04-20
//     3. if (DP(q))            push Zo     // context-1m-2025-08-07
//     4. if (!DISABLE_INTERLEAVED_THINKING && ggq(q))
//                              push fZq    // interleaved-thinking-2025-05-14
//     5. if (Y && ggq(q) && !I7() && showSummaries!==true)
//                              push pZ8    // redact-thinking-2026-02-12
//     6. if (firstParty && !DISABLE_EXPERIMENTAL_BETAS && (A||iO_(q)))
//                              push BZ8    // context-management-2025-06-27
//     7. RESERVED              t76         // structured-outputs-2025-12-15 (tengu_tool_pear)
//     8. RESERVED              Qv1         // web-search-2025-03-05 (vertex/foundry)
//     9. if (Y)                push On6    // prompt-caching-scope-2026-01-05
//    10. push ...env.ANTHROPIC_BETAS, then dedup
//   }

export function assembleBetas(options: AssembleBetasOptions): string[] {
  const provider: ProviderRoute = options.provider ?? "firstParty"
  const modelId = options.modelId ?? ""
  const isHaiku = isHaikuModel(modelId)
  const has1M = supports1MContext(modelId)
  const thinks = supportsThinking(modelId)
  // upstream `ja()` — see cli.js@3481451
  const jaEquivalent =
    isFirstPartyish(provider) && !options.disableExperimentalBetas

  const betas: string[] = []

  // 1. claude-code — upstream ZR1 step 1: skip for haiku
  if (!isHaiku) betas.push(BETA_CLAUDE_CODE)

  // 2. oauth — upstream ZR1 step 2
  if (options.isOAuth) betas.push(BETA_OAUTH)

  // 3. context-1m — upstream ZR1 step 3
  if (has1M) betas.push(BETA_CONTEXT_1M)

  // 4. interleaved-thinking — upstream ZR1 step 4
  if (thinks && !options.disableInterleavedThinking) {
    betas.push(BETA_INTERLEAVED_THINKING)
  }

  // 5. redact-thinking — upstream ZR1 step 5
  // Note: opencode runtime always passes isInteractive=false (DD-17), so this
  // branch only fires in unit tests.
  if (
    jaEquivalent &&
    thinks &&
    !options.disableInterleavedThinking &&
    options.isInteractive === true &&
    options.showThinkingSummaries !== true
  ) {
    betas.push(BETA_REDACT_THINKING)
  }

  // 6. context-management — upstream ZR1 step 6
  // Gate: provider === "firstParty" specifically (NOT isFirstPartyish — note
  // foundry/anthropicAws drop out here per upstream branch ordering)
  if (
    provider === "firstParty" &&
    !options.disableExperimentalBetas &&
    modelSupportsContextManagement(modelId, provider)
  ) {
    betas.push(BETA_CONTEXT_MANAGEMENT)
  }

  // 7. RESERVED — structured-outputs-2025-12-15 (tengu_tool_pear flag, not in opencode path)
  // 8. RESERVED — web-search-2025-03-05 (vertex/foundry only, not in opencode path)

  // 9. prompt-caching-scope — upstream ZR1 step 9 (gated on ja(), NOT isOAuth — DD-11)
  if (jaEquivalent) betas.push(BETA_PROMPT_CACHING_SCOPE)

  // 9b. mid-conversation-system — upstream WW6 step `if (O98(H)) push $a`.
  // O98 → true for the Mythos-class top tier {opus-4-8, fable-5, mythos-5} (every
  // other current model explicitly false, incl. opus-4-7), off under HIPAA /
  // explicit disable / non-first-party. 2.1.170 widened the gate from
  // opus-4-8-only (align-2.1.169 DD-1) for the Fable 5 / Mythos 5 launch.
  if (
    modelEmitsMidConversationSystem(modelId) &&
    isFirstPartyish(provider) &&
    !options.hipaa &&
    options.midConversationSystem !== false
  ) {
    betas.push(BETA_MID_CONVERSATION_SYSTEM)
  }

  // extended-cache-ttl — upstream pushes IWH during cache application when
  // ttl==="1h". Paired with cache_control.ttl:"1h" via CLAUDE_CACHE_TTL (convert.ts).
  if (options.extendedCacheTtl) betas.push(BETA_EXTENDED_CACHE_TTL)

  // (Out-of-band feature gates not present in upstream ZR1 but kept for
  // opencode-side feature plumbing. These do not affect fingerprint parity.)
  if (options.fastMode && supportsFastMode(modelId)) betas.push(BETA_FAST_MODE)
  if (options.effort) betas.push(BETA_EFFORT)
  if (options.taskBudget) betas.push(BETA_TASK_BUDGETS)

  // 10. env-supplied flags — upstream final step
  if (options.envBetas && options.envBetas.length > 0) {
    betas.push(...options.envBetas)
  }

  // Dedup preserving first-occurrence order
  return Array.from(new Set(betas))
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
 * Optional contextual segments for the billing header. Both are STRICTLY
 * conditional (align-2.1.169 DD-2): for a normal main-session interactive turn
 * neither is set, so the header is byte-identical to the pre-2.1.169 output. This
 * matters because the billing header is also system block[0] text feeding the
 * static cache prefix — unconditional new bytes would thrash it.
 */
export interface BillingHeaderOptions {
  /** Workload tag (e.g. "cron"); truthy → ` cc_workload=<workload>;`. upstream H68()/z */
  workload?: string
  /** Running as a subagent session. upstream Y.isMainSession check. */
  isSubagent?: boolean
  /** Whether this is the main session. `isSubagent && !isMainSession` → segment. */
  isMainSession?: boolean
}

/**
 * Build the x-anthropic-billing-header value.
 * Also used as system prompt block[0] text.
 *
 * Upstream (2.1.169): `cc_version=…; cc_entrypoint=…;${cch}${workload}${subagent}`
 *   cch       = " cch=00000;" for non-bedrock/anthropicAws/mantle (opencode = always)
 *   workload  = workload ? ` cc_workload=${workload};` : ""
 *   subagent  = (subagent && !isMainSession) ? " cc_is_subagent=true;" : ""
 */
export function buildBillingHeader(
  content: string,
  entrypoint?: string,
  opts?: BillingHeaderOptions,
): string {
  const hash = calculateAttributionHash(content)
  const ep = entrypoint || process.env.CLAUDE_CODE_ENTRYPOINT || "unknown"
  let header = `cc_version=${VERSION}.${hash}; cc_entrypoint=${ep}; cch=00000;`
  if (opts?.workload) header += ` cc_workload=${opts.workload};`
  if (opts?.isSubagent && !opts.isMainSession) header += ` cc_is_subagent=true;`
  return header
}

/**
 * §3.4: `anthropic-client-platform` header value, by entrypoint. Always present
 * since 2.1.144. opencode impersonates the CLI, so the default is
 * `claude_code_cli`.
 */
export function clientPlatform(entrypoint?: string): string {
  const ep = entrypoint || process.env.CLAUDE_CODE_ENTRYPOINT || "cli"
  switch (ep) {
    case "claude-vscode":
      return "claude_code_vscode"
    case "remote":
    case "remote_baku":
    case "remote_desktop":
    case "remote_mobile":
      return "claude_code_remote"
    case "sdk-cli":
    case "sdk-ts":
    case "sdk-py":
      return "claude_code_sdk"
    case "mcp":
      return "claude_code_mcp"
    case "claude-code-github-action":
      return "claude_code_github_action"
    case "local-agent":
      return "claude_code_local_agent"
    case "claude_in_slack":
      return "claude_in_slack"
    default:
      return "claude_code_cli"
  }
}

/**
 * §6.3: strip the `[1m]`/`[2m]` context-window marker before sending the model
 * ID to the API (upstream `GL()`). The marker is an opencode/CLI-side hint
 * (it drives the context-1m beta), not a valid API model ID.
 */
export function toApiModelId(modelId: string): string {
  return modelId.replace(/\[(1|2)m\]/gi, "")
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
