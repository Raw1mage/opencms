/**
 * Provider chain semantics registry.
 *
 * Static classification of every supported provider into one of:
 *   - SS (stateful)     — uses a server-side chain identifier (typically
 *                          OpenAI Responses API `previous_response_id`).
 *                          A chain break is a real event for these
 *                          providers; the AI loses its server-side
 *                          reasoning trace.
 *   - SL (stateless)    — every request resends full conversation context.
 *                          No chain id, so "chain break" is a no-op.
 *   - Hybrid            — mode-switchable; chain semantics depend on the
 *                          specific request configuration. None registered
 *                          today; reserved for future provider classes
 *                          (e.g. copilot if it ever exposes a runtime
 *                          mode toggle distinct from its current SDK
 *                          fallback rendering).
 *
 * Used by session/continuation/* to dispatch the correct continuation
 * procedure for each (event-kind, provider-class) pair. See
 * /plans/session_rebind-procedure-revision/design.md for the matrix and
 * /specs/session/rebind-procedure-revision/ once graduated.
 *
 * Rule (DD-11): every registered providerId MUST have an explicit entry.
 * Missing classifications fail CI; do not add a runtime default.
 */

import { NamedError } from "@opencode-ai/util/error"
import { z } from "zod"
import { SUPPORTED_PROVIDER_KEYS, type SupportedProviderKey } from "./supported-provider-registry"

export type ProviderChainClass = "SS" | "SL" | "Hybrid"

/**
 * Authoritative chain-class registry. Adding a new providerId to
 * SUPPORTED_PROVIDER_REGISTRY without also adding it here will trip the
 * startup assertion in `assertAllProvidersClassified()`.
 */
const CHAIN_SEMANTICS: Record<SupportedProviderKey, ProviderChainClass> = {
  // OpenAI Responses API — modern models (gpt-5 family) use
  // previous_response_id for server-side chain continuity.
  openai: "SS",

  // Codex CLI — OAuth-authenticated Codex Responses transport; chain
  // identity lives in lastResponseId (per @opencode-ai/provider-codex).
  // This is the canonical SS provider this plan was authored against.
  codex: "SS",

  // GitHub Copilot — uses the OpenAI Responses API surface
  // (packages/opencode/src/provider/sdk/copilot/responses/openai-responses-language-model.ts).
  // The `statelessReasoningIndex` fallback rendering is a per-request
  // format choice, not a runtime mode toggle (DD-6). Chain identity is
  // still previous_response_id when present.
  "github-copilot": "SS",
  "copilot-cli": "SS",

  // Anthropic — stateless Messages API. Every request carries full
  // context; no chain id exists.
  "claude-cli": "SL",

  // Google Gemini — stateless Generative AI API; full-context resend.
  "google-api": "SL",
  "gemini-cli": "SL",

  // OpenRouter — proxy aggregator. Even when its upstream is a stateful
  // model, OpenRouter routes via stateless Chat Completions surface, so
  // opencode never holds a server-side chain id for OpenRouter sessions.
  openrouter: "SL",

  // Vercel AI Gateway — stateless proxy.
  vercel: "SL",

  // GitLab Duo — stateless API surface.
  gitlab: "SL",

  // GMICloud — stateless inference endpoint.
  gmicloud: "SL",

  // OpenCode native — internal provider; treated as stateless because
  // its message protocol carries the full conversation per request.
  opencode: "SL",
}

export const ProviderChainClassSchema = z.enum(["SS", "SL", "Hybrid"])

/**
 * Classify a providerId into its chain semantics class. Throws
 * `ProviderChainSemanticsMissingError` for any providerId that is not
 * present in the static registry — by design; see DD-11.
 *
 * Callers that legitimately receive untrusted provider strings should
 * pre-validate via `isSupportedProviderKey` before calling here.
 */
export function classifyProvider(providerId: string): ProviderChainClass {
  if (!(providerId in CHAIN_SEMANTICS)) {
    throw new ProviderChainSemanticsMissingError({ providerId })
  }
  return CHAIN_SEMANTICS[providerId as SupportedProviderKey]
}

/**
 * Startup-time invariant. Ensures the chain-semantics registry covers
 * every providerId in SUPPORTED_PROVIDER_KEYS. Intended to be invoked
 * once during daemon boot (or at module import via the test below).
 *
 * Throws `ProviderChainSemanticsMissingError` for the first missing key.
 */
export function assertAllProvidersClassified(): void {
  for (const key of SUPPORTED_PROVIDER_KEYS) {
    if (!(key in CHAIN_SEMANTICS)) {
      throw new ProviderChainSemanticsMissingError({ providerId: key })
    }
  }
}

/**
 * Test seam — returns the static registry verbatim for property-style
 * inspections (e.g. "every entry classified into a known class").
 */
export function getChainSemanticsSnapshot(): Readonly<Record<string, ProviderChainClass>> {
  return Object.freeze({ ...CHAIN_SEMANTICS })
}

export const ProviderChainSemanticsMissingError = NamedError.create(
  "ProviderChainSemanticsMissingError",
  z.object({ providerId: z.string() }),
)
