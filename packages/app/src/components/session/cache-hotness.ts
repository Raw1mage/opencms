import type { AssistantMessage, Message } from "@opencode-ai/sdk/v2/client"

/**
 * Round-over-round cache "hotness".
 *
 * The question this answers is NOT "what fraction of THIS round's prompt was a
 * cache hit" (that within-round ratio looks high even when the cache is being
 * re-created every turn). It is: "did the PREVIOUS round's context survive into
 * this round, or did it get zeroed and re-paid as fresh input?"
 *
 * That is the same axis the backend cliff detector uses
 * (packages/opencode/src/session/prompt.ts `evaluateSsCacheHealth`,
 * `currentCache < prev.cacheRead * 0.5`) — here we render it per round as a
 * thermal glyph instead of only firing on a cliff.
 *
 * Why it exposes a "fake-hot" codex cache: codex never reports a separate
 * cache-write, so a single round's cached_tokens can look large while the
 * prefix is silently invalidated turn-to-turn. When that happens this round's
 * `cache.read` collapses toward 0 and `input` (fresh) spikes — so the
 * carry-over ratio drops and the glyph turns ❄️ cold. That is the
 * "用量消耗得那麼快" tell: each turn re-pays the whole context.
 */
export type CacheHotnessState = "hot" | "warm" | "cold" | "seed" | "reset"

export type CacheHotness = {
  state: CacheHotnessState
  /** currentRead / prevContext, clamped to [0,1]; undefined for seed/reset. */
  carryRatio?: number
  /** Previous round's full prompt (input + cache.read + cache.write). */
  prevContext?: number
  /** This round's cache.read. */
  currentRead?: number
}

// Carried ≥70% of last round's context → hot; <30% → effectively zeroed (cliff).
const HOT_THRESHOLD = 0.7
const WARM_THRESHOLD = 0.3

type AssistantLike = AssistantMessage & {
  providerId?: string
  providerID?: string
  accountId?: string
  summary?: boolean
}

const tokenTotal = (msg: AssistantMessage) =>
  msg.tokens.input + msg.tokens.output + msg.tokens.reasoning + msg.tokens.cache.read + msg.tokens.cache.write

const completedAt = (msg: AssistantMessage) => msg.time.completed ?? msg.time.created ?? 0

const providerOf = (msg: AssistantLike) => msg.providerId ?? msg.providerID
const accountOf = (msg: AssistantLike) => msg.accountId

/**
 * Compute hotness from the message stream. Looks at the two most recent
 * assistant messages that actually hit the model (tokens > 0), in chronological
 * order, and compares the latest round's cache read against the prior round's
 * full prompt.
 */
export function computeCacheHotness(messages: Message[] = []): CacheHotness | undefined {
  const rounds = messages
    .filter((m): m is AssistantMessage => m.role === "assistant" && tokenTotal(m as AssistantMessage) > 0)
    .sort((a, b) => completedAt(a) - completedAt(b))
  if (rounds.length === 0) return undefined

  const cur = rounds[rounds.length - 1] as AssistantLike
  const prev = rounds.length >= 2 ? (rounds[rounds.length - 2] as AssistantLike) : undefined

  // First model round of the session — nothing to carry over yet.
  if (!prev) return { state: "seed" }

  // Planned reset: a provider/account switch or a compaction anchor legitimately
  // drops the cache. Don't slander it as cold — that's the backend's
  // planned-source classification, surfaced here as ♻️.
  const switched = providerOf(cur) !== providerOf(prev) || accountOf(cur) !== accountOf(prev)
  if (switched || cur.summary === true) return { state: "reset" }

  const prevContext = prev.tokens.input + prev.tokens.cache.read + prev.tokens.cache.write
  const currentRead = cur.tokens.cache.read
  if (prevContext <= 0) return { state: "seed" }

  const carryRatio = Math.min(1, currentRead / prevContext)
  const state: CacheHotnessState =
    carryRatio >= HOT_THRESHOLD ? "hot" : carryRatio >= WARM_THRESHOLD ? "warm" : "cold"
  return { state, carryRatio, prevContext, currentRead }
}

export function cacheHotnessGlyph(state: CacheHotnessState): string {
  switch (state) {
    case "hot":
      return "🔥"
    case "warm":
      return "🌡️"
    case "cold":
      return "❄️"
    case "reset":
      return "♻️"
    case "seed":
      return "·"
  }
}

/** Short English caption, e.g. for a dedicated telemetry line. */
export function cacheHotnessSummary(hotness: CacheHotness): string {
  const glyph = cacheHotnessGlyph(hotness.state)
  if (hotness.state === "seed") return `${glyph} seeding — first cached round`
  if (hotness.state === "reset") return `${glyph} reset — provider/account switch or compaction`
  const pct = Math.round((hotness.carryRatio ?? 0) * 100)
  if (hotness.state === "hot") return `${glyph} hot — ${pct}% of last round's context reused`
  if (hotness.state === "warm") return `${glyph} warm — only ${pct}% of last round's context reused`
  return `${glyph} cold — ${pct}% of last round's context reused (cliff)`
}
