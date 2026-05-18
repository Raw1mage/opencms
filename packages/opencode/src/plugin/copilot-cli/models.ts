/**
 * Model list and routing logic for copilot-cli provider.
 *
 * Uses feature flags from profile to determine chat vs responses API routing.
 * Falls back to heuristic (isGpt5OrLater) when flags are unavailable.
 */

import { getProfile } from "./auth"

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
