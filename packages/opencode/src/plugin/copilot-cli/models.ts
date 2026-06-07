/**
 * Model list and routing logic for copilot-cli provider.
 *
 * Uses feature flags from profile to determine chat vs responses API routing.
 * Falls back to heuristic (isGpt5OrLater) when flags are unavailable.
 */

import { getProfile } from "./auth"
import { getCachedPremiumQuota } from "./quota"
import { ToolBudget } from "../../tool/budget"
import { Log } from "../../util/log"

const log = Log.create({ service: "copilot-cli.auto" })

// ---------------------------------------------------------------------------
// "auto" low-cost model router
//
// `auto` is a synthetic model id (registered in provider.ts, copilot-cli only)
// that resolves to a concrete, verified-supported model at request time. It
// mirrors GitHub Copilot's "Auto" picker behaviourally: bias to the cheapest
// capable model and conserve the premium-request budget. The server-side
// billing discount GitHub applies to its own "Auto" is NOT reachable on the
// raw CAPI path (that path rejects model:"auto" with 400), so this is a
// client-side router over the low-cost tier — which is the only tier the raw
// path serves anyway.
//
// Each tier's primary MUST be an id present in COPILOT_CLI_MODELS (provider.ts);
// there is no request-time fallback, so an unsupported id would 400.
// ---------------------------------------------------------------------------

export const AUTO_MODEL_ID = "auto"

const AUTO_TIERS = {
  // gpt-5.4-mini: reasoning-capable mini, 400K ctx, cheapest premium-request cost.
  lightweight: "gpt-5.4-mini",
  // gpt-4.1: solid generalist on the chat path.
  versatile: "gpt-4.1",
  // gemini-3.1-pro-preview: strongest model available on this path.
  powerful: "gemini-3.1-pro-preview",
} as const

// Token thresholds (estimated request size) for tier escalation. Tuned so a
// normal agentic turn (system + tools + a few messages, ~15-40K) stays
// lightweight; only genuinely large/deep contexts escalate.
const VERSATILE_TOKEN_THRESHOLD = 64_000
const POWERFUL_TOKEN_THRESHOLD = 200_000

// Downshift to lightweight when the premium budget is below this fraction.
const QUOTA_DOWNSHIFT_PERCENT = 10

/**
 * Resolve the synthetic `auto` model to a concrete supported model id.
 *
 * Signals:
 *  - estimated request size (shared ToolBudget.estimateTokens — same standard
 *    the rest of the runtime uses, CJK-aware) drives tier escalation;
 *  - an explicit high/xhigh reasoning effort nudges off lightweight;
 *  - a nearly-exhausted premium-interactions quota forces lightweight.
 *
 * Never throws and never blocks a request: quota lookups are cached and
 * failure-tolerant.
 */
export async function resolveAutoModel(input: {
  promptText: string
  reasoningEffort?: string
}): Promise<string> {
  const est = ToolBudget.estimateTokens(input.promptText)

  let tier: keyof typeof AUTO_TIERS = "lightweight"
  if (est >= POWERFUL_TOKEN_THRESHOLD) tier = "powerful"
  else if (est >= VERSATILE_TOKEN_THRESHOLD) tier = "versatile"

  if (tier === "lightweight" && (input.reasoningEffort === "high" || input.reasoningEffort === "xhigh")) {
    tier = "versatile"
  }

  // Quota-aware downshift: conserve premium budget when nearly exhausted.
  let downshifted = false
  try {
    const q = await getCachedPremiumQuota()
    if (
      q &&
      !q.isUnlimitedEntitlement &&
      typeof q.remainingPercentage === "number" &&
      q.remainingPercentage < QUOTA_DOWNSHIFT_PERCENT
    ) {
      tier = "lightweight"
      downshifted = true
    }
  } catch {
    // never block a request on quota
  }

  const resolved = AUTO_TIERS[tier]
  log.info("auto resolved", { tier, resolved, estTokens: est, downshifted })
  return resolved
}

function isGpt5OrLater(modelID: string): boolean {
  const match = /^gpt-(\d+)/.exec(modelID)
  if (!match) return false
  return Number(match[1]) >= 5
}

/**
 * Determine whether a model should use the Responses API or Chat Completions API.
 *
 * Priority:
 * 1. Feature flags from profile (copilot_cli_websocket_responses, etc.)
 * 2. Fallback heuristic: GPT-5+ (excluding gpt-5-mini) → Responses API
 */
export function shouldUseResponsesApi(modelID: string): boolean {
  const profile = getProfile()

  if (profile) {
    const flags = profile.featureFlags
    // If the server tells us to use responses API for this model family, do it
    if (flags["copilot_cli_websocket_responses"]) {
      return isGpt5OrLater(modelID) && !modelID.startsWith("gpt-5-mini")
    }
  }

  // Default heuristic (same as existing github-copilot loader)
  return isGpt5OrLater(modelID) && !modelID.startsWith("gpt-5-mini")
}
