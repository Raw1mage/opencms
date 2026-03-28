/**
 * Provider Capabilities Abstraction
 *
 * This module centralizes provider-specific behavior detection,
 * replacing scattered hardcoded checks like:
 *   - isCodex = provider.id.includes("openai") && auth?.type === "oauth"
 *   - isAnthropicOAuth = provider.id.includes("anthropic") && auth?.type === "oauth"
 *   - isGeminiCli = provider.id.includes("gemini-cli")
 */

import type { Auth } from "../auth"
import type { Provider } from "./provider"

/**
 * Describes the capabilities and behavioral characteristics of a provider.
 */
export interface ProviderCapabilities {
  /**
   * Whether this provider uses the `options.instructions` field for system prompts
   * instead of sending them as system messages.
   * When true: system prompts go to options.instructions
   * When false: system prompts are sent as { role: "system", content: ... } messages
   */
  useInstructionsOption: boolean

  /**
   * How system prompts should be sent in the message array.
   * - "system": Use { role: "system", content: ... }
   * - "user": Wrap in { role: "user", content: ... } (some APIs require this)
   * - "developer": Use { role: "developer", content: ... } (OpenAI Codex style)
   *
   * Note: When useInstructionsOption is true, this affects how any remaining
   * system content is formatted if it still needs to go in messages.
   */
  systemMessageRole: "system" | "user" | "developer"

  /**
   * Whether to skip SystemPrompt.provider() when agent has no custom prompt.
   * This is typically true for managed/subscription providers that have
   * their own system prompts injected via instructions.
   */
  skipDefaultSystemPrompt: boolean

  /**
   * Whether to skip maxOutputTokens calculation.
   * Some providers (like Codex) handle this automatically.
   */
  skipMaxOutputTokens: boolean

  /**
   * Whether this is a LiteLLM proxy or similar that requires
   * a dummy tool when message history contains tool calls.
   */
  requiresDummyToolForHistory: boolean

  /**
   * The authentication type used by this provider.
   */
  authType: "api" | "oauth" | "subscription" | "none"

  /**
   * Provider family for grouping (useful for fallback logic).
   */
  family: "openai" | "anthropic" | "google-api" | "gemini-cli" | "other"
}

/**
 * Default capabilities for unknown/standard providers.
 */
const DEFAULT_CAPABILITIES: ProviderCapabilities = {
  useInstructionsOption: false,
  systemMessageRole: "system",
  skipDefaultSystemPrompt: false,
  skipMaxOutputTokens: false,
  requiresDummyToolForHistory: false,
  authType: "api",
  family: "other",
}

/**
 * Determines the capabilities of a provider based on its ID and auth type.
 *
 * @param provider - The provider info
 * @param auth - Optional auth info for the provider
 * @returns The provider's capabilities
 */
export function getCapabilities(provider: Provider.Info, auth?: Auth.Info): ProviderCapabilities {
  const id = provider.id.toLowerCase()

  // Codex Provider (independent C plugin)
  if (id === "codex") {
    return {
      useInstructionsOption: true,
      systemMessageRole: "developer",
      skipDefaultSystemPrompt: true,
      skipMaxOutputTokens: true,
      requiresDummyToolForHistory: false,
      authType: "subscription",
      family: "openai",
    }
  }

  // Gemini CLI: Google AI via Gemini CLI OAuth
  if (id.includes("gemini-cli")) {
    return {
      useInstructionsOption: true,
      systemMessageRole: "user",
      skipDefaultSystemPrompt: true,
      skipMaxOutputTokens: false,
      requiresDummyToolForHistory: false,
      authType: "oauth",
      family: "gemini-cli",
    }
  }

  // OpenAI Codex (OAuth subscription)
  if (id.includes("openai") && auth?.type === "oauth") {
    return {
      useInstructionsOption: true,
      systemMessageRole: "user",
      skipDefaultSystemPrompt: true,
      skipMaxOutputTokens: true,
      requiresDummyToolForHistory: false,
      authType: "oauth",
      family: "openai",
    }
  }

  // Anthropic OAuth (subscription)
  if (id.includes("anthropic") && auth?.type === "oauth") {
    return {
      useInstructionsOption: true,
      systemMessageRole: "user",
      skipDefaultSystemPrompt: true,
      skipMaxOutputTokens: false,
      requiresDummyToolForHistory: false,
      authType: "oauth",
      family: "anthropic",
    }
  }

  // GitHub Copilot
  if (id.includes("github-copilot")) {
    return {
      ...DEFAULT_CAPABILITIES,
      skipMaxOutputTokens: true,
      authType: "oauth",
      family: "other",
    }
  }

  // LiteLLM proxy detection
  if (provider.options?.["litellmProxy"] === true || id.includes("litellm")) {
    return {
      ...DEFAULT_CAPABILITIES,
      requiresDummyToolForHistory: true,
      family: "other",
    }
  }

  // Standard OpenAI (API key)
  if (id.includes("openai")) {
    return {
      ...DEFAULT_CAPABILITIES,
      authType: auth?.type === "api" ? "api" : "oauth",
      family: "openai",
    }
  }

  // Standard Anthropic (API key)
  if (id.includes("anthropic")) {
    return {
      ...DEFAULT_CAPABILITIES,
      authType: auth?.type === "api" ? "api" : "oauth",
      family: "anthropic",
    }
  }

  // Standard Google (API key)
  if (id.includes("google") || id.includes("gemini")) {
    return {
      ...DEFAULT_CAPABILITIES,
      authType: "api",
      family: "google-api",
    }
  }

  return DEFAULT_CAPABILITIES
}

/**
 * Convenience function to check if a provider uses the instructions option.
 */
export function usesInstructionsOption(provider: Provider.Info, auth?: Auth.Info): boolean {
  return getCapabilities(provider, auth).useInstructionsOption
}

/**
 * Convenience function to check if a provider should skip maxOutputTokens.
 */
export function shouldSkipMaxOutputTokens(provider: Provider.Info, auth?: Auth.Info): boolean {
  return getCapabilities(provider, auth).skipMaxOutputTokens
}

/**
 * Convenience function to check if a provider requires dummy tools.
 */
export function requiresDummyTool(provider: Provider.Info, model: Provider.Model): boolean {
  const id = provider.id.toLowerCase()
  const apiId = model.api.id.toLowerCase()

  return provider.options?.["litellmProxy"] === true || id.includes("litellm") || apiId.includes("litellm")
}
