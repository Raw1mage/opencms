/**
 * HTTP header builder — whitelist mode, built from scratch.
 *
 * Phase 2A: No header inheritance from any upstream layer.
 * Ref: claude-code@2.1.126 official header set.
 */
import { appendFileSync } from "node:fs"
import { homedir } from "node:os"
import {
  VERSION,
  API_VERSION,
  assembleBetas,
  buildBillingHeader,
  clientPlatform,
  CLAUDE_CACHE_TTL,
  BETA_MID_CONVERSATION_SYSTEM,
  type AssembleBetasOptions,
  type ProviderRoute,
} from "./protocol.js"

// ---------------------------------------------------------------------------
// § 2A.1  buildHeaders — construct all request headers from scratch
// ---------------------------------------------------------------------------

export interface BuildHeadersOptions {
  /** Bearer access token */
  accessToken: string
  /** Model ID for beta flag assembly */
  modelId: string
  /** Whether auth is OAuth/subscription. opencode always passes true (DD-16). */
  isOAuth: boolean
  /** Organization UUID (optional) */
  orgID?: string
  /** Content for billing header hash (first user message text) */
  billingContent?: string
  /** Entrypoint for billing header */
  entrypoint?: string
  /** Fast mode enabled */
  fastMode?: boolean
  /** Effort parameter used */
  effort?: boolean
  /** Task budget specified */
  taskBudget?: boolean
  /** Extra betas from ANTHROPIC_BETAS env */
  envBetas?: string[]
  /** Routing target. opencode always firstParty (DD-4). */
  provider?: ProviderRoute
  /** Suppresses redact-thinking. */
  showThinkingSummaries?: boolean
  /** Resolved from CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS at the call site. */
  disableExperimentalBetas?: boolean
  /** Resolved from DISABLE_INTERLEAVED_THINKING at the call site. */
  disableInterleavedThinking?: boolean
  /** True iff running in interactive TTY. opencode daemon always false (DD-17). */
  isInteractive?: boolean
  /** HIPAA mode — disables mid-conversation-system (align-2.1.169 DD-1). */
  hipaa?: boolean
  /** Explicit mid-conversation-system override; false force-disables on opus-4-8. */
  midConversationSystem?: boolean
  /** Workload tag for billing header (e.g. "cron"). align-2.1.169 DD-2. */
  workload?: string
  /** Subagent session — billing header cc_is_subagent. align-2.1.169 DD-2. */
  isSubagent?: boolean
  /** Whether this is the main session (subagent && !main → cc_is_subagent). */
  isMainSession?: boolean
}

export function buildHeaders(options: BuildHeadersOptions): Headers {
  const headers = new Headers()

  // Required headers — exactly matching official CLI
  headers.set("Authorization", `Bearer ${options.accessToken}`)
  headers.set("anthropic-version", API_VERSION)
  headers.set("Content-Type", "application/json")
  headers.set("User-Agent", `claude-code/${VERSION}`)
  // §3.4: always-present since 2.1.144. Missing it was a fingerprint gap.
  headers.set("anthropic-client-platform", clientPlatform(options.entrypoint))

  // Beta flags — dynamic per-request assembly (1:1 forward)
  const betaOptions: AssembleBetasOptions = {
    isOAuth: options.isOAuth,
    modelId: options.modelId,
    fastMode: options.fastMode,
    effort: options.effort,
    taskBudget: options.taskBudget,
    extendedCacheTtl: CLAUDE_CACHE_TTL === "1h",
    envBetas: options.envBetas,
    provider: options.provider,
    showThinkingSummaries: options.showThinkingSummaries,
    disableExperimentalBetas: options.disableExperimentalBetas,
    disableInterleavedThinking: options.disableInterleavedThinking,
    isInteractive: options.isInteractive,
    hipaa: options.hipaa,
    midConversationSystem: options.midConversationSystem,
  }
  const betas = assembleBetas(betaOptions)
  headers.set("anthropic-beta", betas.join(","))

  // Per-request beta-fingerprint diagnostic (align-2.1.169). Mirrors
  // claude-cache-breakpoints.jsonl: one line per request recording the exact
  // anthropic-beta sent on the wire + the model, so opus-4-8 mid-conversation-
  // system parity (and future betas drift) is observable without external
  // capture. Diagnostic only — must never affect the request path.
  try {
    appendFileSync(
      `${homedir()}/.local/share/opencode/log/claude-betas.jsonl`,
      JSON.stringify({
        t: new Date().toISOString(),
        model: options.modelId,
        provider: options.provider ?? "firstParty",
        betas,
        midConversationSystem: betas.includes(BETA_MID_CONVERSATION_SYSTEM),
      }) + "\n",
    )
  } catch {
    /* diagnostic only */
  }

  // Billing header — workload/subagent segments are strictly conditional, so the
  // common-case (main-session, no workload) value is byte-identical to before
  // (align-2.1.169 DD-2: keep the cache-prefix-feeding header stable).
  if (options.billingContent) {
    headers.set(
      "x-anthropic-billing-header",
      buildBillingHeader(options.billingContent, options.entrypoint, {
        workload: options.workload,
        isSubagent: options.isSubagent,
        isMainSession: options.isMainSession,
      }),
    )
  }

  // Organization
  if (options.orgID) {
    headers.set("x-organization-uuid", options.orgID)
  }

  return headers
}
