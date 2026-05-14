/**
 * Codex model catalog.
 *
 * Context limits and capabilities for compact_threshold calculation.
 * Source: packages/opencode/src/provider/provider.ts lines 1260-1305
 */

export interface CodexModelSpec {
  id: string
  name: string
  contextWindow: number
  maxOutput: number
  reasoning: boolean
}

export const MODEL_CATALOG: CodexModelSpec[] = [
  { id: "gpt-5.5", name: "GPT-5.5", contextWindow: 272_000, maxOutput: 128_000, reasoning: true },
  { id: "gpt-5.4", name: "GPT-5.4", contextWindow: 400_000, maxOutput: 128_000, reasoning: true },
  { id: "gpt-5.4-mini", name: "GPT-5.4 Mini", contextWindow: 200_000, maxOutput: 64_000, reasoning: false },
  { id: "gpt-5.3-codex", name: "GPT-5.3 Codex", contextWindow: 400_000, maxOutput: 128_000, reasoning: true },
  { id: "gpt-5.2-codex", name: "GPT-5.2 Codex", contextWindow: 400_000, maxOutput: 128_000, reasoning: true },
  { id: "gpt-5.2", name: "GPT-5.2", contextWindow: 400_000, maxOutput: 128_000, reasoning: true },
  { id: "gpt-5.1-codex-max", name: "GPT-5.1 Codex Max", contextWindow: 400_000, maxOutput: 128_000, reasoning: true },
  { id: "gpt-5.1-codex-mini", name: "GPT-5.1 Codex Mini", contextWindow: 200_000, maxOutput: 64_000, reasoning: false },
]

const MODEL_MAP = new Map(MODEL_CATALOG.map((m) => [m.id, m]))

/** Default context window for unknown models */
const DEFAULT_CONTEXT_WINDOW = 200_000
const DEFAULT_MAX_OUTPUT = 64_000

export function getModelSpec(modelId: string): CodexModelSpec | undefined {
  return MODEL_MAP.get(modelId)
}

export function getContextWindow(modelId: string): number {
  return MODEL_MAP.get(modelId)?.contextWindow ?? DEFAULT_CONTEXT_WINDOW
}

export function getMaxOutput(modelId: string): number {
  return MODEL_MAP.get(modelId)?.maxOutput ?? DEFAULT_MAX_OUTPUT
}

/**
 * Calculate server-side compaction threshold.
 * 80% of context window — leaves room for client-side compaction at ~96%.
 */
export function getCompactThreshold(modelId: string): number {
  return Math.floor(getContextWindow(modelId) * 0.8)
}
