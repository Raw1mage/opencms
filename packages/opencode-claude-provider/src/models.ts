/**
 * Claude model catalog.
 *
 * Source of truth: @anthropic-ai/claude-code@2.1.92 (zz8 max output overrides)
 * + protocol-datasheet.md § 9
 */

export interface ClaudeModelSpec {
  id: string
  /** Display name */
  name: string
  /** Default context window (tokens) */
  context: number
  /** Default max output tokens */
  maxOutput: number
  /** Whether context-1m beta can extend to 1M */
  supports1MContext: boolean
  /** Whether the model supports thinking */
  supportsThinking: boolean
  /** Cost per million tokens (USD), 0 for subscription */
  cost: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
  }
}

/**
 * Max output token overrides from official CLI (zz8 in minified).
 * Models NOT listed here use the API default.
 */
const MAX_OUTPUT_OVERRIDES: Record<string, number> = {
  "claude-opus-4-20250514": 8192,
  "claude-opus-4-0": 8192,
  "claude-4-opus-20250514": 8192,
  "claude-opus-4-1-20250805": 8192,
}

/**
 * Get the max output tokens for a model, applying CLI overrides.
 */
export function getMaxOutput(modelId: string, apiDefault = 16384): number {
  return MAX_OUTPUT_OVERRIDES[modelId] ?? apiDefault
}

/**
 * Static model catalog.
 * Pricing set to 0 — subscription auth doesn't bill per-token.
 * For API-key auth, pricing should come from the API or be configured.
 */
export const MODEL_CATALOG: ClaudeModelSpec[] = [
  {
    id: "claude-sonnet-4-6-20250627",
    name: "Claude Sonnet 4.6",
    context: 200_000,
    maxOutput: 16384,
    supports1MContext: true,
    supportsThinking: true,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "claude-opus-4-6-20250627",
    name: "Claude Opus 4.6",
    context: 200_000,
    maxOutput: 8192,
    supports1MContext: true,
    supportsThinking: true,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "claude-sonnet-4-5-20250514",
    name: "Claude Sonnet 4.5",
    context: 200_000,
    maxOutput: 16384,
    supports1MContext: true,
    supportsThinking: true,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "claude-opus-4-20250514",
    name: "Claude Opus 4",
    context: 200_000,
    maxOutput: 8192,
    supports1MContext: true,
    supportsThinking: true,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "claude-opus-4-1-20250805",
    name: "Claude Opus 4.1",
    context: 200_000,
    maxOutput: 8192,
    supports1MContext: true,
    supportsThinking: true,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "claude-haiku-4-5-20251001",
    name: "Claude Haiku 4.5",
    context: 200_000,
    maxOutput: 16384,
    supports1MContext: false,
    supportsThinking: true,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
]

/**
 * Look up a model spec by ID. Returns undefined if not in catalog.
 */
export function findModel(modelId: string): ClaudeModelSpec | undefined {
  return MODEL_CATALOG.find((m) => m.id === modelId)
}

/**
 * Check if a model ID matches any known model (exact or prefix match).
 */
export function isKnownModel(modelId: string): boolean {
  return MODEL_CATALOG.some(
    (m) => m.id === modelId || modelId.startsWith(m.id.split("-").slice(0, -1).join("-")),
  )
}
