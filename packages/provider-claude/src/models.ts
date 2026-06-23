/**
 * Claude model catalog.
 *
 * Source of truth: @anthropic-ai/claude-code@2.1.186 (LMH() output table)
 * + protocol-datasheet.md § 9. Verify/realign with:
 *   bun packages/provider-claude/scripts/sync-from-cli.ts
 *
 * 2026-05-29: added Opus 4.8 (claude-opus-4-8) + Opus 4.5; realigned the whole
 * max-output table to upstream LMH() — opus-4-6/4-7/4-8 = 64000, other 4.x =
 * 32000. The old hand-copied "zz8" table capped opus at 8192 and was stale
 * since ≥2.1.141, truncating replies at 8192 output tokens.
 * 2026-06-10: 2.1.170 Mythos-class launch — added Fable 5 (claude-fable-5) to
 * the catalog and the 64000 max-output tier alongside Mythos 5 (claude-mythos-5,
 * wire-gate only, not in the picker: access-restricted). Upstream groups both as
 * `K==="claude-fable-5"||K==="claude-mythos-5")$=64000,q=128000`.
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

/** Per-model output-token limits. */
export interface OutputLimit {
  /** Default `max_tokens` the CLI sends when the caller omits one. */
  default: number
  /** Ceiling the CLAUDE_CODE_MAX_OUTPUT_TOKENS env override is clamped to. */
  upperLimit: number
}

/**
 * Output-token table — faithful replica of upstream `LMH()` in
 * @anthropic-ai/claude-code (verified against 2.1.141 + 2.1.156 + 2.1.169).
 *
 * Keys are NORMALIZED base model IDs (date / -vN / -fast / -latest / [1m]
 * suffixes and provider prefixes stripped — see {@link normalizeModelId}).
 * The previous hand-copied "zz8" table capped opus models at 8192, which was
 * stale by ≥2.1.141 — the real CLI sends 64000 for opus-4-6/4-7/4-8.
 */
const OUTPUT_LIMITS: Record<string, OutputLimit> = {
  "claude-fable-5": { default: 64000, upperLimit: 128000 },
  "claude-mythos-5": { default: 64000, upperLimit: 128000 },
  "claude-opus-4-8": { default: 64000, upperLimit: 128000 },
  "claude-opus-4-7": { default: 64000, upperLimit: 128000 },
  "claude-opus-4-6": { default: 64000, upperLimit: 128000 },
  "claude-sonnet-4-6": { default: 32000, upperLimit: 128000 },
  "claude-opus-4-5": { default: 32000, upperLimit: 64000 },
  "claude-sonnet-4-5": { default: 32000, upperLimit: 64000 },
  "claude-sonnet-4-0": { default: 32000, upperLimit: 64000 },
  "claude-sonnet-4": { default: 32000, upperLimit: 64000 },
  "claude-haiku-4-5": { default: 32000, upperLimit: 64000 },
  "claude-opus-4-1": { default: 32000, upperLimit: 32000 },
  "claude-opus-4-0": { default: 32000, upperLimit: 32000 },
  "claude-opus-4": { default: 32000, upperLimit: 32000 },
  "claude-3-7-sonnet": { default: 32000, upperLimit: 64000 },
  "claude-3-5-sonnet": { default: 8192, upperLimit: 8192 },
  "claude-3-5-haiku": { default: 8192, upperLimit: 8192 },
  "claude-3-opus": { default: 4096, upperLimit: 4096 },
  "claude-3-sonnet": { default: 8192, upperLimit: 8192 },
  "claude-3-haiku": { default: 4096, upperLimit: 4096 },
}

/** upstream else branch: oe1 (default) / ae1 (upperLimit). */
const DEFAULT_OUTPUT_LIMIT: OutputLimit = { default: 32000, upperLimit: 128000 }

/**
 * Normalize a model ID to its base key (upstream O7 + xG): lowercase, drop the
 * `[1m]` 1M-context marker, normalize `._` to `-`, strip provider region/vendor
 * prefixes and trailing date / -vN / -fast / -latest qualifiers.
 */
export function normalizeModelId(modelId: string): string {
  let id = modelId.toLowerCase().replace(/\[1m\]$/, "").replace(/[._]/g, "-")
  id = id.replace(/^(us|eu|apac|global)-/, "").replace(/^anthropic-/, "")
  let prev: string
  do {
    prev = id
    id = id.replace(/-(\d{8}|v\d+|fast|latest)$/, "")
  } while (id !== prev)
  return id
}

/** Per-model output limits (upstream LMH), keyed by normalized model ID. */
export function getOutputLimit(modelId: string): OutputLimit {
  return OUTPUT_LIMITS[normalizeModelId(modelId)] ?? DEFAULT_OUTPUT_LIMIT
}

/**
 * Effective default `max_tokens` for a model — upstream `LMH().default` with
 * the `CLAUDE_CODE_MAX_OUTPUT_TOKENS` env override applied and clamped to
 * `upperLimit` (upstream E5H + n$H). Invalid/≤0 env values fall back to default.
 */
export function getMaxOutput(modelId: string): number {
  const { default: def, upperLimit } = getOutputLimit(modelId)
  const env = process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
  if (env) {
    const n = Number.parseInt(env, 10)
    if (Number.isFinite(n) && n > 0) return Math.min(n, upperLimit)
  }
  return def
}

/**
 * Static model catalog.
 * Pricing set to 0 — subscription auth doesn't bill per-token.
 * For API-key auth, pricing should come from the API or be configured.
 */
export const MODEL_CATALOG: ClaudeModelSpec[] = [
  {
    id: "claude-fable-5",
    name: "Claude Fable 5",
    context: 200_000,
    maxOutput: 64000,
    supports1MContext: true,
    supportsThinking: true,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "claude-opus-4-8",
    name: "Claude Opus 4.8",
    context: 200_000,
    maxOutput: 64000,
    supports1MContext: true,
    supportsThinking: true,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "claude-opus-4-7",
    name: "Claude Opus 4.7",
    context: 200_000,
    maxOutput: 64000,
    supports1MContext: true,
    supportsThinking: true,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "claude-sonnet-4-6-20250627",
    name: "Claude Sonnet 4.6",
    context: 200_000,
    maxOutput: 32000,
    supports1MContext: true,
    supportsThinking: true,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "claude-opus-4-6-20250627",
    name: "Claude Opus 4.6",
    context: 200_000,
    maxOutput: 64000,
    supports1MContext: true,
    supportsThinking: true,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "claude-opus-4-5-20251101",
    name: "Claude Opus 4.5",
    context: 200_000,
    maxOutput: 32000,
    supports1MContext: true,
    supportsThinking: true,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "claude-sonnet-4-5-20250514",
    name: "Claude Sonnet 4.5",
    context: 200_000,
    maxOutput: 32000,
    supports1MContext: true,
    supportsThinking: true,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "claude-opus-4-20250514",
    name: "Claude Opus 4",
    context: 200_000,
    maxOutput: 32000,
    supports1MContext: true,
    supportsThinking: true,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "claude-opus-4-1-20250805",
    name: "Claude Opus 4.1",
    context: 200_000,
    maxOutput: 32000,
    supports1MContext: true,
    supportsThinking: true,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "claude-haiku-4-5-20251001",
    name: "Claude Haiku 4.5",
    context: 200_000,
    maxOutput: 32000,
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
