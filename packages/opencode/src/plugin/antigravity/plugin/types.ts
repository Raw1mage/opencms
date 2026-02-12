
import type { GoogleSearchConfig } from "./transform/types"

/**
 * Basic JSON Schema interface.
 */
export interface JsonSchema {
  type?: string | string[]
  description?: string
  properties?: Record<string, JsonSchema>
  items?: JsonSchema | JsonSchema[]
  required?: string[]
  enum?: unknown[]
  const?: unknown
  allOf?: JsonSchema[]
  anyOf?: JsonSchema[]
  oneOf?: JsonSchema[]
  additionalProperties?: boolean | JsonSchema
  $ref?: string
  format?: string
  default?: unknown
  // Constraints
  minLength?: number
  maxLength?: number
  pattern?: string
  minItems?: number
  maxItems?: number
  exclusiveMinimum?: number | boolean
  exclusiveMaximum?: number | boolean
  minimum?: number
  maximum?: number
  // Index signature for extensibility
  [key: string]: unknown
}

export interface GeminiPart {
  text?: string
  thought?: boolean
  thoughtSignature?: string
  signature?: string
  type?: string // Anthropic-style
  thinking?: string // Anthropic-style
  functionCall?: {
    name: string
    args: Record<string, unknown>
  }
  tool_use?: unknown
  toolUse?: unknown
  tool_result?: unknown
  functionResponse?: unknown
  inlineData?: {
    mimeType: string
    data: string
  }
  cache_control?: unknown
  providerMetadata?: unknown
  [key: string]: unknown
}

export interface GeminiContent {
  role?: string
  parts: GeminiPart[]
  [key: string]: unknown
}

export interface GeminiCandidate {
  content: GeminiContent
  [key: string]: unknown
}

export interface AntigravityApiError {
  code?: number
  message?: string
  status?: string
  details?: unknown[]
  [key: string]: unknown
}

/**
 * Minimal representation of Antigravity API responses we touch.
 */
export interface AntigravityApiBody {
  response?: unknown
  error?: AntigravityApiError
  candidates?: GeminiCandidate[]
  choices?: unknown[] // OpenAI style
  content?: unknown // Anthropic style
  [key: string]: unknown
}

/**
 * Usage metadata exposed by Antigravity responses. Fields are optional to reflect partial payloads.
 */
export interface AntigravityUsageMetadata {
  totalTokenCount?: number
  promptTokenCount?: number
  candidatesTokenCount?: number
  cachedContentTokenCount?: number
  thoughtsTokenCount?: number
}

/**
 * Normalized thinking configuration accepted by Antigravity.
 */
export interface ThinkingConfig {
  thinkingBudget?: number
  includeThoughts?: boolean
}

/**
 * Variant thinking config extracted from OpenCode's providerOptions.
 */
export interface VariantThinkingConfig {
  /** Gemini 3 native thinking level (low/medium/high) */
  thinkingLevel?: string
  /** Numeric thinking budget for Claude and Gemini 2.5 */
  thinkingBudget?: number
  /** Whether to include thoughts in output */
  includeThoughts?: boolean
  /** Google Search configuration */
  googleSearch?: GoogleSearchConfig
}

export interface AntigravityRequestPayload {
  contents?: GeminiContent[]
  messages?: unknown[] // Anthropic style messages
  systemInstruction?: {
    role?: string
    parts: GeminiPart[]
  } | string | { parts: { text: string }[] }
  tools?: unknown[]
  toolConfig?: unknown
  generationConfig?: Record<string, unknown>
  model?: string
  [key: string]: unknown
}
