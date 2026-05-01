import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Session } from "."
import { Identifier } from "../id/id"
import { Instance } from "../project/instance"
import { Provider } from "../provider/provider"
import { MessageV2 } from "./message-v2"
import z from "zod"
import { Token } from "../util/token"
import { Log } from "../util/log"
import { SessionProcessor } from "./processor"
import { fn } from "@/util/fn"
import { Agent } from "@/agent/agent"
import { Plugin } from "@/plugin"
import { Config } from "@/config/config"
import { ProviderTransform } from "@/provider/transform"
import { SessionPrompt } from "./prompt"
import { SharedContext } from "./shared-context"
import { Memory } from "./memory"
import { Tweaks } from "../config/tweaks"
import { PostCompaction } from "./post-compaction"
import { ContinuationInvalidatedEvent } from "../plugin/codex-auth"
import { emitCompactionPredicateTelemetry, emitKindChainTelemetry } from "./compaction-telemetry"

// Subscribe to continuation invalidation. compaction-redesign DD-11:
// state-driven signal — write timestamp onto session.execution; the
// runloop's deriveObservedCondition compares against the most recent
// Anchor's time.created and fires run({observed: "continuation-invalidated"})
// when it sees a fresh signal. Implicit cooldown via anchor-recency.
Bus.subscribe(ContinuationInvalidatedEvent, (evt) => {
  void Session.markContinuationInvalidated(evt.properties.sessionId).catch(() => {})
})

// Phase 13.2-B: SessionDeleted hook for deleteRebindCheckpoint and the
// pruneStaleCheckpoints startup timer are gone — the disk-file checkpoint
// surface no longer exists.

export namespace SessionCompaction {
  const log = Log.create({ service: "session.compaction" })

  // Phase 7: pendingRebindCompaction Set, markRebindCompaction, and
  // consumeRebindCompaction deleted. Continuation-invalidated signal is now
  // state-driven via session.execution.continuationInvalidatedAt (DD-11);
  // rebind detection happens via deriveObservedCondition's accountId / providerId
  // comparison against the most recent Anchor's identity.

  // Phase 13.2-B: RebindCheckpoint disk-file surface fully removed.
  // Recovery is now single-source: scan the messages stream for the most
  // recent anchor (`assistant.summary === true`) and slice from there.
  // Implementation lives in prompt.ts (`applyStreamAnchorRebind` / Phase
  // 13.2-A). Bus event handlers above (Session.deleted hook,
  // pruneStaleCheckpoints timer) are gone; daemon-startup leaves residual
  // disk files alone — user backups stay untouched, no auto-cleanup.

  /**
   * Sanitize orphaned tool calls/results in a ModelMessage array.
   * Replaces unmatched tool-call parts with a plain text placeholder and
   * unmatched tool-result parts with a plain text placeholder.
   * Returns a new array — original is NOT modified.
   */
  export function sanitizeOrphanedToolCalls(messages: import("ai").ModelMessage[]): any[] {
    // Collect all call_ids from tool-call parts
    const callIds = new Set<string>()
    // Collect all toolCallIds from tool-result parts
    const resultIds = new Set<string>()
    for (const msg of messages) {
      const content = (msg as any).content
      if (!Array.isArray(content)) continue
      for (const part of content) {
        if (part?.type === "tool-call") callIds.add(part.toolCallId)
        if (part?.type === "tool-result") resultIds.add(part.toolCallId)
      }
    }

    const missingResults: string[] = []
    const missingCalls: string[] = []

    // First pass: identify which IDs are orphaned
    for (const id of callIds) {
      if (!resultIds.has(id)) missingResults.push(id)
    }
    for (const id of resultIds) {
      if (!callIds.has(id)) missingCalls.push(id)
    }

    if (missingResults.length === 0 && missingCalls.length === 0) return messages

    log.warn("sanitizeOrphanedToolCalls: found orphaned tool calls/results", {
      missingResults,
      missingCalls,
    })

    const missingResultSet = new Set(missingResults)
    const missingCallSet = new Set(missingCalls)

    return messages
      .map((msg) => {
        const content = (msg as any).content
        if (!Array.isArray(content)) return msg
        const role = (msg as any).role as string

        // For role:"tool" messages: if ANY tool-result references an orphaned call,
        // drop the entire message. The ModelMessage schema only allows tool-result
        // parts inside role:"tool", so we can't replace them with text placeholders.
        if (role === "tool") {
          const hasOrphan = content.some(
            (part: any) => part?.type === "tool-result" && missingCallSet.has(part.toolCallId),
          )
          if (hasOrphan) return null
          return msg
        }

        // For role:"assistant" messages: replace orphaned tool-calls with text placeholders.
        let dirty = false
        const newContent = content.map((part: any) => {
          if (part?.type === "tool-call" && missingResultSet.has(part.toolCallId)) {
            dirty = true
            return { type: "text", text: `[tool result missing: ${part.toolCallId}]` }
          }
          return part
        })

        if (!dirty) return msg
        return { ...msg, content: newContent }
      })
      .filter(Boolean)
  }

  export const Event = {
    Compacted: BusEvent.define(
      "session.compacted",
      z.object({
        sessionID: z.string(),
      }),
    ),
    CompactionStarted: BusEvent.define(
      "session.compaction.started",
      z.object({
        sessionID: z.string(),
        // "auto" fires the moment compaction.run() decides to walk the
        // kind chain, before any kind has actually executed — gives the UI
        // a toaster trigger that's not gated on codex round-trips inside
        // low-cost-server. plugin / llm / hybrid_llm / hybrid_llm_background
        // fire from per-kind sites and indicate which kind committed the
        // anchor. UI typically just needs ANY of these to show the toaster.
        mode: z.enum(["auto", "plugin", "llm", "hybrid_llm", "hybrid_llm_background"]),
      }),
    ),
  }

  /**
   * Publish Event.Compacted AND reset codex's per-session chain
   * (lastResponseId). Bridge: after every compaction, clear codex's
   * server-side chain pointer so next request starts fresh — without
   * this, codex accumulates a hidden chain via previous_response_id
   * that grows past model.contextLimit even when opencode's own
   * observedTokens shows ample room.
   *
   * Direct call (not Bus.subscribe) because subscriber-pattern was
   * unreliable — Instance scoping difference between subscriber
   * registration time and event publish time meant the callback
   * never fired in production. Inline call from every Compacted
   * publish site is verbose but reliable.
   *
   * Use this helper anywhere we used to call Bus.publish(Event.Compacted, ...).
   */
  export async function publishCompactedAndResetChain(sessionID: string) {
    Bus.publish(Event.Compacted, { sessionID })
    try {
      const { invalidateContinuationFamily } = await import("@opencode-ai/codex-provider/continuation")
      invalidateContinuationFamily(sessionID)
      Log.create({ service: "session.compaction" }).info(
        "codex chain family reset after compaction (lastResponseId cleared)",
        { sessionID },
      )
    } catch (err) {
      Log.create({ service: "session.compaction" }).warn("codex chain reset failed (non-fatal)", {
        sessionID,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const COMPACTION_BUFFER = 20_000
  const DEFAULT_HEADROOM = 8_000
  const DEFAULT_COOLDOWN_ROUNDS = 8
  const EMERGENCY_CEILING = 2_000
  const SMALL_CONTEXT_MAX = 128_000
  const SMALL_CONTEXT_RESERVED_TOKENS = 5_000
  const CHARS_PER_TOKEN = 4

  // Billing-aware compaction: by-token providers benefit from aggressive
  // compaction (smaller context = lower cost per round), while by-request
  // providers should preserve context (no per-token cost, compaction only
  // loses information). models.dev marks by-request providers with cost=0.
  const BY_TOKEN_HEADROOM = 80_000
  const BY_TOKEN_COOLDOWN_ROUNDS = 4
  const BY_REQUEST_OPPORTUNISTIC_THRESHOLD = 1.0 // effectively disabled

  function isByTokenBilling(model: Provider.Model): boolean {
    return model.cost.input > 0
  }

  /**
   * Returns true if the model has sufficient context to produce a meaningful summary.
   * Models with context < 16k are unlikely to hold enough history for useful compaction.
   */
  export function canSummarize(model: Provider.Model): boolean {
    const contextLimit = model.limit?.context ?? 0
    return contextLimit >= 16000
  }

  // Phase 13.1: recordCompaction / getCooldownState removed. Cooldown reads
  // the most recent anchor message's `time.created` directly via
  // `Cooldown.shouldThrottle` — there's no separate Memory.lastCompactedAt
  // store to update or look up.

  export async function inspectBudget(input: { tokens: MessageV2.Assistant["tokens"]; model: Provider.Model }) {
    const config = await Config.get()
    const context = input.model.limit.context
    const count =
      input.tokens.total ||
      input.tokens.input + input.tokens.output + input.tokens.cache.read + input.tokens.cache.write

    const byToken = isByTokenBilling(input.model)
    const headroom = config.compaction?.headroom ?? (byToken ? BY_TOKEN_HEADROOM : DEFAULT_HEADROOM)
    const reserved =
      config.compaction?.reserved ??
      Math.max(
        headroom,
        Math.min(
          COMPACTION_BUFFER,
          ProviderTransform.maxOutputTokens(
            input.model.providerId,
            {},
            input.model.limit.output || 32_000,
            SessionPrompt.OUTPUT_TOKEN_MAX,
          ),
        ),
      )

    const reservedBasedUsable = input.model.limit.input
      ? input.model.limit.input - reserved
      : context -
        ProviderTransform.maxOutputTokens(
          input.model.providerId,
          {},
          input.model.limit.output || 32_000,
          SessionPrompt.OUTPUT_TOKEN_MAX,
        )

    // Threshold-based usable: when `compaction.overflowThreshold` is set
    // (fraction of context, e.g. 0.9), it OVERRIDES the legacy
    // reserved-based formula. Compaction fires when count crosses
    // `context * threshold` regardless of how much output headroom
    // remains. This is safe because compaction runs BEFORE the next LLM
    // call: the round that triggers overflow doesn't make an API call,
    // it writes an anchor and the next iteration's prompt is dramatically
    // smaller. The default (undefined) keeps the legacy reserved-based
    // formula for backward compatibility.
    //
    // Recommended values:
    //   0.9 — fire compaction at 90% of context (user's preferred default
    //         for codex/byToken billing where the legacy 80K headroom
    //         produced overly-aggressive ~70% triggers)
    const overflowThreshold = config.compaction?.overflowThreshold
    const usable = typeof overflowThreshold === "number" ? Math.floor(context * overflowThreshold) : reservedBasedUsable

    // Emergency ceiling: hard limit that ignores cooldown
    const emergencyCeiling = input.model.limit.input
      ? input.model.limit.input - EMERGENCY_CEILING
      : context - EMERGENCY_CEILING

    return {
      auto: config.compaction?.auto !== false,
      context,
      inputLimit: input.model.limit.input,
      reserved,
      usable,
      count,
      overflow: config.compaction?.auto !== false && context !== 0 && count >= usable,
      emergency: config.compaction?.auto !== false && context !== 0 && count >= emergencyCeiling,
      cooldownRounds:
        config.compaction?.cooldownRounds ?? (byToken ? BY_TOKEN_COOLDOWN_ROUNDS : DEFAULT_COOLDOWN_ROUNDS),
      byToken,
    }
  }

  export async function isOverflow(input: {
    tokens: MessageV2.Assistant["tokens"]
    model: Provider.Model
    sessionID?: string
    currentRound?: number
  }) {
    const budget = await inspectBudget(input)
    if (!budget.overflow) return false

    // Emergency: always compact regardless of cooldown
    if (budget.emergency) {
      log.info("emergency compaction triggered", {
        sessionID: input.sessionID,
        count: budget.count,
        emergencyCeiling: budget.context - EMERGENCY_CEILING,
      })
      return true
    }

    // Phase 13.1: round-based cooldown removed. The single cooldown gate is
    // `Cooldown.shouldThrottle(sessionID)` in `run()`, anchored on the most
    // recent anchor message's `time.created` (30s window). isOverflow now
    // returns the raw token-comparison verdict; cooldown is decided upstream.

    return true
  }

  // Cache-aware compaction: when cache hit rate is poor and context is large
  // enough to matter, compact proactively to reduce billable input tokens.
  // This catches the case where context keeps growing (but hasn't overflowed)
  // while cache is mostly missing — wasting tokens re-sending stale history.
  const CACHE_AWARE_MIN_UTILIZATION = 0.4 // context must be >= 40% full
  const CACHE_AWARE_MAX_HIT_RATE = 0.4 // cache hit rate must be below 40%
  const CACHE_AWARE_MIN_INPUT = 40_000 // skip when input is trivially small

  export async function shouldCacheAwareCompact(input: {
    tokens: MessageV2.Assistant["tokens"]
    model: Provider.Model
    sessionID?: string
    currentRound?: number
  }): Promise<boolean> {
    const budget = await inspectBudget(input)
    if (!budget.auto || !budget.byToken) return false

    // Only meaningful when there's substantial context
    const utilization = budget.usable > 0 ? budget.count / budget.usable : 0
    if (utilization < CACHE_AWARE_MIN_UTILIZATION) return false

    const { input: inputTokens, cache } = input.tokens
    const totalInput = inputTokens + cache.read
    if (totalInput < CACHE_AWARE_MIN_INPUT) return false

    const cacheHitRate = totalInput > 0 ? cache.read / totalInput : 1
    if (cacheHitRate >= CACHE_AWARE_MAX_HIT_RATE) return false

    // Phase 13.1: round-based cooldown removed (see isOverflow comment).
    // Cooldown gate happens once in `run()` via `Cooldown.shouldThrottle`.

    log.warn("cache-aware compaction triggered", {
      sessionID: input.sessionID,
      cacheHitRate: (cacheHitRate * 100).toFixed(0) + "%",
      utilization: (utilization * 100).toFixed(0) + "%",
      inputTokens,
      cacheRead: cache.read,
      count: budget.count,
      usable: budget.usable,
    })
    return true
  }

  // Phase 13 follow-up (2026-04-28): tool-output prune retired. The 80%
  // utilization GC was cache-hostile (every prune mutates mid-prompt bytes
  // → kills codex prefix-cache for 80%→90% window) and only delayed the
  // 90% compaction by ~10% utilization. Net effect was negative: paid full
  // input tokens between 80% and 90% to avoid one cheap compaction event.
  // Single threshold now: compaction fires at the configured overflow
  // threshold (default 90%), narrative kind writes a fresh anchor, cache
  // rebuilds naturally from there.

  /**
   * Default target token cap for post-compaction prompts (DD-? double-phase).
   * Local kinds (narrative, replay-tail) trim themselves to this budget; if the
   * resulting summary still exceeds it AND the chain has paid kinds remaining,
   * `run()` escalates to the next kind. Override via config
   * `compaction.targetPromptTokens`.
   *
   * 50K chosen as a hard ceiling well below typical 200K context — leaves
   * headroom for system prompt + new user turn + tool outputs without
   * blowing past the model's overflow threshold on the very next round.
   */
  export const DEFAULT_TARGET_PROMPT_TOKENS = 50_000

  async function resolveTargetPromptTokens(): Promise<number> {
    const cfg = await Config.get().catch(() => undefined)
    const v = cfg?.compaction?.targetPromptTokens
    return typeof v === "number" && v > 0 ? v : DEFAULT_TARGET_PROMPT_TOKENS
  }

  /** Local (zero-API-cost) kinds — these get the target-cap escalation path. */
  function isLocalKind(k: KindName): boolean {
    return k === "narrative" || k === "replay-tail"
  }

  // Phase 13 follow-up: prune function deleted. See note above the
  // DEFAULT_TARGET_PROMPT_TOKENS block. Single 90%-overflow gate via
  // `run({observed: "overflow"})` is the only context-management path.

  /**
   * @deprecated Phase 7 deleted the only caller (`prompt.ts` legacy
   * compaction-request branch). Kept as a shim that delegates to the new
   * single entry point so any pre-phase-7 caller still compiles. Phase 9
   * (next release) removes it. Emits `log.warn` so missed callers surface
   * in CI.
   */
  export async function process(input: {
    parentID: string
    messages: MessageV2.WithParts[]
    sessionID: string
    abort: AbortSignal
    auto: boolean
  }): Promise<"continue" | "stop"> {
    log.warn("SessionCompaction.process is deprecated; use SessionCompaction.run", {
      sessionID: input.sessionID,
    })
    return run({
      sessionID: input.sessionID,
      observed: input.auto ? "overflow" : "manual",
      step: 0,
      abort: input.abort,
    })
  }

  /**
   * Idle compaction: triggered at turn boundary when a completed task dispatch
   * is detected and context utilization exceeds the opportunistic threshold.
   *
   * Phase 13.3-full (REVISED 2026-04-28): routes through the unified `run()`
   * entry point (DD-9) instead of calling `SharedContext.snapshot` directly.
   * `KIND_CHAIN["idle"] = ["narrative", "replay-tail"]` covers the same
   * "free, no-API" intent that the legacy snapshot path had — but reads from
   * the messages stream + Memory journal instead of the regex-extracted
   * SharedContext text. Single source of truth.
   */
  export async function idleCompaction(input: { sessionID: string; model: Provider.Model; config: Config.Info }) {
    const tokens = await getLastAssistantTokens(input.sessionID)
    if (!tokens) return
    const budget = await inspectBudget({ tokens, model: input.model })
    if (!budget.auto) return

    const byToken = isByTokenBilling(input.model)
    const defaultThreshold = byToken ? 0.6 : BY_REQUEST_OPPORTUNISTIC_THRESHOLD
    const threshold = input.config.compaction?.opportunisticThreshold ?? defaultThreshold
    const utilization = budget.usable > 0 ? budget.count / budget.usable : 0
    log.info("idle compaction evaluation", { utilization, threshold, count: budget.count, usable: budget.usable })

    if (utilization < threshold) return

    await run({
      sessionID: input.sessionID,
      observed: "idle",
      step: 0,
    })
  }

  /**
   * Shared context compaction: creates a synthetic summary message from the
   * snapshot, replacing the LLM compaction agent call. Used by both idle
   * compaction and overflow compaction paths.
   */
  export async function compactWithSharedContext(input: {
    sessionID: string
    snapshot: string
    model: Provider.Model
    auto: boolean
  }) {
    log.info("compacting with shared context", { sessionID: input.sessionID })

    // Announce compaction start immediately so the UI toast fires at the
    // beginning of the 30s+ snapshot-and-save window. Mirrors process() which
    // already publishes this at its entry; the shared-context priority path
    // used to bypass it entirely and the toast only showed on Compacted.
    Bus.publish(Event.CompactionStarted, { sessionID: input.sessionID, mode: "plugin" })

    const msgs = await Session.messages({ sessionID: input.sessionID })
    const parentID = msgs.at(-1)?.info.id
    if (!parentID) return

    const userMessage = msgs.findLast((m) => m.info.role === "user")?.info as MessageV2.User | undefined
    if (!userMessage) return

    // Create summary assistant message
    const summaryMsg = (await Session.updateMessage({
      id: Identifier.ascending("message"),
      role: "assistant",
      parentID,
      sessionID: input.sessionID,
      mode: "compaction",
      agent: "compaction",
      variant: userMessage.variant,
      summary: true,
      path: {
        cwd: Instance.directory,
        root: Instance.worktree,
      },
      cost: 0,
      tokens: {
        output: 0,
        input: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      modelID: input.model.id,
      providerId: input.model.providerId,
      accountId: userMessage.model.accountId,
      time: {
        created: Date.now(),
      },
    })) as MessageV2.Assistant

    // 1. Write transcript summary as a text part.
    //
    // Append the post-compaction quick follow-up table (RC fix 2026-05-01):
    // history truncation drops every prior tool call from the LLM-visible
    // stream, so the model loses the memory that runtime-persisted state
    // (todolist, in-flight subagents, ...) already encodes. PostCompaction
    // walks a registry of providers and renders each one's slice of state
    // into the summary text. Adding a new follow-up = register a provider;
    // compaction.ts stays untouched.
    const followUps = await PostCompaction.gather(input.sessionID)
    const followUpAddendum = PostCompaction.buildSummaryAddendum(followUps)
    await Session.updatePart({
      id: Identifier.ascending("part"),
      messageID: summaryMsg.id,
      sessionID: input.sessionID,
      type: "text",
      text: input.snapshot + followUpAddendum,
      time: {
        start: Date.now(),
        end: Date.now(),
      },
    })

    // 2. Write the CRITICAL compaction anchor point for history truncation
    await Session.updatePart({
      id: Identifier.ascending("part"),
      messageID: summaryMsg.id,
      sessionID: input.sessionID,
      type: "compaction",
      auto: input.auto,
    })

    log.info("shared context compaction complete", { sessionID: input.sessionID })

    // Phase 13.2-B: disk-file checkpoint write removed. The anchor message
    // written above IS the durable record; rebind reads it via stream scan.

    void publishCompactedAndResetChain(input.sessionID)

    if (input.auto) {
      // Create continue message for auto mode
      const continueMsg = await Session.updateMessage({
        id: Identifier.ascending("message"),
        role: "user",
        sessionID: input.sessionID,
        time: { created: Date.now() },
        agent: userMessage.agent,
        model: userMessage.model,
        format: userMessage.format,
        variant: userMessage.variant,
      })
      // Build a concrete continuation directive from the same follow-up
      // table. Each provider contributes a one-line continueHint; the
      // builder stitches them into a numbered directive. This replaces the
      // bare "Continue if you have next steps" wording, which was too
      // abstract post-compaction and produced the re-establishing-todowrite
      // loop.
      const continueText = PostCompaction.buildContinueText(followUps)
      await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID: continueMsg.id,
        sessionID: input.sessionID,
        type: "text",
        synthetic: true,
        text: continueText,
        time: {
          start: Date.now(),
          end: Date.now(),
        },
      })
    }
  }

  /** Helper: get token counts from the last assistant message in a session */
  async function getLastAssistantTokens(sessionID: string): Promise<MessageV2.Assistant["tokens"] | undefined> {
    const msgs = await Session.messages({ sessionID })
    const last = msgs.findLast((m) => m.info.role === "assistant")
    if (!last) return undefined
    const info = last.info as MessageV2.Assistant
    return info.tokens
  }

  export function truncateModelMessagesForSmallContext(input: {
    messages: MessageV2.WithParts[]
    model: Provider.Model
    sessionID?: string
  }) {
    const modelMessages = MessageV2.toModelMessages(input.messages, input.model)
    const contextLimit = input.model.limit.context || 0
    const smallContextLimit = Math.min(contextLimit, SMALL_CONTEXT_MAX)
    const safeTokenBudget = smallContextLimit - SMALL_CONTEXT_RESERVED_TOKENS
    const safeCharBudget = safeTokenBudget * CHARS_PER_TOKEN

    if (smallContextLimit === 0 || safeCharBudget <= 0) {
      return { messages: modelMessages, truncated: false, safeCharBudget: 0 }
    }

    const currentSize = JSON.stringify(modelMessages).length
    if (currentSize <= safeCharBudget) {
      return { messages: modelMessages, truncated: false, safeCharBudget }
    }

    const truncated = [] as typeof modelMessages
    let size = 2
    for (let index = modelMessages.length - 1; index >= 0; index--) {
      const message = modelMessages[index]
      const messageSize = JSON.stringify(message).length + 1
      if (truncated.length > 0 && size + messageSize > safeCharBudget) break
      truncated.unshift(message)
      size += messageSize
    }

    if (truncated.length === 1 && JSON.stringify(truncated).length > safeCharBudget) {
      const only = structuredClone(truncated[0]) as any
      while (JSON.stringify([only]).length > safeCharBudget) {
        const parts = Array.isArray(only.parts) ? only.parts : []
        const textIndex = parts.findIndex(
          (part: any) => part?.type === "text" && typeof part.text === "string" && part.text.length > 0,
        )
        if (textIndex === -1) break
        const text = parts[textIndex].text as string
        parts[textIndex].text = text.length <= 512 ? "" : text.slice(-Math.floor(text.length / 2))
      }
      truncated[0] = only
    }

    log.warn("compaction history truncated to fit small model context", {
      sessionID: input.sessionID,
      originalChars: currentSize,
      truncatedChars: JSON.stringify(truncated).length,
      safeCharBudget,
    })

    return { messages: truncated, truncated: true, safeCharBudget }
  }

  // Phase 7: tryPluginCompaction deleted. The plugin session.compact hook
  // is now invoked by tryLowCostServer (kind 4 of the new chain). The
  // conversation-items builder (`buildConversationItemsForPlugin`) lives
  // alongside that executor.

  export const create = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      agent: z.string(),
      model: z.object({
        providerId: z.string(),
        modelID: z.string(),
      }),
      format: MessageV2.Format.optional(),
      auto: z.boolean(),
    }),
    async (input) => {
      const msg = await Session.updateMessage({
        id: Identifier.ascending("message"),
        role: "user",
        model: input.model,
        format: input.format,
        sessionID: input.sessionID,
        agent: input.agent,
        variant: undefined,
        time: {
          created: Date.now(),
        },
      })
      await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID: msg.id,
        sessionID: msg.sessionID,
        type: "compaction-request",
        auto: input.auto,
      })
    },
  )

  // ── compaction-redesign phase 4 — single entry point + tables ────────
  // See specs/compaction-redesign/{spec.md, design.md, data-schema.json}.
  // DD-9: SessionCompaction.run is the single entry point for every
  // compaction execution. Triggers are observed conditions (not signals).
  // Kind selection is a data table walk, not branching code.

  export type Observed =
    | "overflow"
    | "cache-aware"
    | "rebind"
    | "continuation-invalidated"
    | "provider-switched"
    | "stall-recovery"
    | "manual"
    | "idle"
    | "empty-response"

  export type KindName = "narrative" | "replay-tail" | "low-cost-server" | "llm-agent"
  // Note: hybrid_llm is intentionally NOT a KindName. It runs as a
  // background post-step AFTER the chain commits an anchor. See
  // run() success path + scheduleHybridEnrichment() below.

  export type RunInput = {
    sessionID: string
    observed: Observed
    step: number
    intent?: "default" | "rich"
    /**
     * Abort signal for the kind chain, threaded through to executors that
     * make API calls (low-cost-server, llm-agent). Optional: when omitted,
     * a fresh AbortController is used internally so the legacy callers
     * that don't supply one still work.
     */
    abort?: AbortSignal
  }

  export type RunResult = "continue" | "stop"

  /**
   * Cost-monotonic kind chains per observed condition.
   * - free narrative + schema + replay-tail: kinds 1-3
   * - low-cost-server: codex/openai /responses/compact (kind 4)
   * - llm-agent: full LLM round (kind 5)
   *
   * `rebind` / `continuation-invalidated` chains stop at kind 3 — these
   * triggers are maintenance, not enrichment, so the runloop should not
   * burn quota on them. `provider-switched` starts with narrative but may
   * fall back to replay-tail, which is still local and gives the next
   * provider a bounded text recovery surface when narrative cannot build a
   * useful anchor.
   *
   * Phase 13 (REVISED 2026-04-28): `schema` kind removed. Its sole role was
   * scavenging text from legacy SharedContext when narrative was empty —
   * but a fresh session should be empty, not back-filled from regex extracts.
   * Narrative empty → chain falls through to next kind naturally.
   */
  const KIND_CHAIN: Readonly<Record<Observed, ReadonlyArray<KindName>>> = Object.freeze({
    overflow: Object.freeze(["narrative", "replay-tail", "low-cost-server", "llm-agent"] as const),
    "cache-aware": Object.freeze(["narrative", "replay-tail", "low-cost-server", "llm-agent"] as const),
    idle: Object.freeze(["narrative", "replay-tail"] as const),
    rebind: Object.freeze(["narrative", "replay-tail"] as const),
    "continuation-invalidated": Object.freeze(["narrative", "replay-tail"] as const),
    "provider-switched": Object.freeze(["narrative", "replay-tail"] as const),
    "stall-recovery": Object.freeze(["narrative", "replay-tail", "low-cost-server", "llm-agent"] as const),
    manual: Object.freeze(["narrative", "low-cost-server", "llm-agent"] as const),
    // empty-response auto-heal: codex's server-side compact gets first crack
    // because the most likely root cause of the empty packet is codex's own
    // context having silently overflowed; letting codex decide what to keep
    // is more useful than a local narrative replay. Falls through to local
    // kinds for non-codex providers (low-cost-server fails fast there).
    "empty-response": Object.freeze(["low-cost-server", "narrative", "replay-tail", "llm-agent"] as const),
  })

  export function kindChainFor(observed: Observed): ReadonlyArray<KindName> {
    return KIND_CHAIN[observed]
  }

  export function resolveKindChain(input: {
    observed: Observed
    providerId?: string
    isSubscription?: boolean
    ctxRatio?: number
    codexServerPriorityRatio?: number
  }): ReadonlyArray<KindName> {
    const base = KIND_CHAIN[input.observed]
    const threshold = input.codexServerPriorityRatio ?? Tweaks.compactionSync().codexServerPriorityRatio
    const codexSubscription = input.providerId === "codex" && input.isSubscription === true
    if (!codexSubscription || (input.ctxRatio ?? 0) <= threshold) return base
    if (input.observed === "overflow" || input.observed === "cache-aware") {
      return ["low-cost-server", "narrative", "replay-tail", "llm-agent"] as const
    }
    if (input.observed === "manual") {
      return ["low-cost-server", "narrative", "llm-agent"] as const
    }
    return base
  }

  function isSubscriptionCostModel(model: Provider.Model | undefined): boolean {
    if (!model) return false
    return model.providerId === "codex" && model.cost.input === 0 && model.cost.output === 0
  }

  async function sessionContextRatio(sessionID: string, model: Provider.Model | undefined): Promise<number> {
    if (!model) return 0
    const tokens = await getLastAssistantTokens(sessionID).catch(() => undefined)
    const window = model.limit.input ?? model.limit.context
    if (!tokens || !window) return 0
    return tokens.input / window
  }

  /**
   * Whether a synthetic "Continue if you have next steps..." user message
   * is appended after the anchor. Only system-driven token-pressure triggers
   * permit it. Per R-6, rebind / continuation-invalidated / provider-switched
   * never inject Continue — that gate's the 2026-04-27 infinite loop bug
   * structurally extinct.
   */
  const INJECT_CONTINUE: Readonly<Record<Observed, boolean>> = Object.freeze({
    overflow: true,
    "cache-aware": true,
    idle: true,
    rebind: false,
    "continuation-invalidated": false,
    "provider-switched": false,
    "stall-recovery": false,
    manual: false,
    // empty-response auto-heal: token pressure drove the burp, so a synthetic
    // "Continue from where you left off" after the anchor lets the model
    // resume the user's actual request without a fresh user prompt.
    "empty-response": true,
  })

  /**
   * Cooldown helper. DD-13 (REVISED 2026-04-28): the source-of-truth is the
   * most recent anchor message's `time.created` in the messages stream.
   *
   * DD-7's `Memory.lastCompactedAt` (round + timestamp dual) is superseded.
   * The messages stream is the single durable record; no Memory file, no
   * round counter. A 30-second timestamp window prevents oscillation —
   * within or across runloop invocations, the rule is the same: if the
   * latest anchor was written less than 30s ago, throttle.
   *
   * No anchor exists → never throttle (first-ever compaction always
   * proceeds).
   */
  export namespace Cooldown {
    /**
     * Single cooldown window. 30 seconds absorbs both within-runloop
     * oscillation (where `step` advances rapidly) and the cross-runloop
     * case (where `step` resets) using the same rule, eliminating the
     * round-vs-timestamp dual logic from the previous design.
     */
    export const COOLDOWN_MS = 30_000

    export async function shouldThrottle(sessionID: string): Promise<boolean> {
      const messages = await Session.messages({ sessionID }).catch(() => [] as MessageV2.WithParts[])
      const anchor = findMostRecentAnchorMessage(messages)
      if (!anchor) return false
      const anchorTime = (anchor.info as MessageV2.Assistant).time?.created ?? 0
      if (!anchorTime) return false
      return Date.now() - anchorTime < COOLDOWN_MS
    }

    function findMostRecentAnchorMessage(messages: MessageV2.WithParts[]): MessageV2.WithParts | undefined {
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i]
        if (m.info.role === "assistant" && (m.info as MessageV2.Assistant).summary === true) {
          return m
        }
      }
      return undefined
    }
  }

  /**
   * Result of attempting a single kind in the chain.
   *
   * `anchorWritten`: when true, the executor already wrote the anchor message
   * itself (used by `tryLlmAgent`, where the LLM round needs an already-
   * persisted assistant message to write parts into). run() detects this and
   * skips the _writeAnchor call. For all other kinds, leave it false/absent
   * and run() handles the anchor write through `compactWithSharedContext`.
   */
  type KindAttempt =
    | { ok: false; reason: string }
    | { ok: true; summaryText: string; kind: KindName; anchorWritten?: boolean; truncated?: boolean }

  async function tryNarrative(input: RunInput, model: Provider.Model | undefined): Promise<KindAttempt> {
    const mem = await Memory.read(input.sessionID)
    const target = await resolveTargetPromptTokens()
    const contextLimit = model?.limit?.context || 0
    const modelBudget = Math.floor(contextLimit * 0.3)
    const cap = modelBudget > 0 ? Math.min(modelBudget, target) : target
    // Render uncapped first to detect whether the full content exceeds cap.
    // If so, signal `truncated: true` so run() can decide whether to commit
    // this lossy local result or escalate to a paid kind that can compress
    // intelligently. Then re-render with the cap to get the actual payload.
    const fullText = Memory.renderForLLMSync(mem)
    if (!fullText) return { ok: false, reason: "memory empty" }
    const fullEstimate = Math.ceil(fullText.length / 4)
    const truncated = fullEstimate > cap
    const text = truncated ? Memory.renderForLLMSync(mem, cap) : fullText
    return { ok: true, summaryText: text, kind: "narrative", truncated }
  }

  /**
   * Replay-tail executor. Serializes the last N raw rounds (user +
   * assistant text, in chronological order) as plain text. N defaults to
   * `Memory.rawTailBudget` (default 5). Zero API cost. Used when narrative +
   * schema both empty AND raw tail still readable. Fallback for crash
   * recovery per DD-2.
   *
   * NOT used for `provider-switched` because raw assistant text may carry
   * provider-specific tool-call structure that the new provider can't read;
   * the table excludes it for that observed value.
   */
  async function tryReplayTail(input: RunInput, model: Provider.Model | undefined): Promise<KindAttempt> {
    const mem = await Memory.read(input.sessionID)
    const budgetN = mem.rawTailBudget || 5
    const msgs = await Session.messages({ sessionID: input.sessionID }).catch(() => undefined)
    if (!msgs || msgs.length === 0) return { ok: false, reason: "no messages" }

    // Take the trailing rounds. A "round" here is a user message followed by
    // its assistant turn; we walk back from the tail collecting until we have
    // budgetN messages (close enough; consumer just needs context).
    const tail = msgs.slice(Math.max(0, msgs.length - budgetN * 2))
    const lines: string[] = []
    for (const m of tail) {
      const role = m.info.role
      if (role !== "user" && role !== "assistant") continue
      const text = m.parts
        .filter((p: any) => p.type === "text")
        .map((p: any) => (p as any).text ?? "")
        .join("\n")
        .trim()
      if (!text) continue
      lines.push(`${role === "user" ? "User" : "Assistant"}: ${text}`)
    }
    if (lines.length === 0) return { ok: false, reason: "tail has no text content" }

    let text = lines.join("\n\n")
    const target = await resolveTargetPromptTokens()
    const contextLimit = model?.limit?.context || 0
    const modelBudget = Math.floor(contextLimit * 0.3)
    const cap = modelBudget > 0 ? Math.min(modelBudget, target) : target
    const maxChars = cap * 4
    let truncated = false
    if (text.length > maxChars) {
      truncated = true
      // Newest-first preservation: walk lines from the end, accumulate until
      // budget exhausted, then keep that suffix. Drops the oldest rounds.
      const kept: string[] = []
      let used = 0
      for (let i = lines.length - 1; i >= 0; i--) {
        const candidate = lines[i]
        const next = used + (used > 0 ? 2 : 0) + candidate.length
        if (next > maxChars) {
          if (kept.length === 0) {
            // Single newest line exceeds cap — truncate from the END to
            // preserve start (usually the user prompt or assistant headline).
            kept.unshift(candidate.slice(0, maxChars))
          }
          break
        }
        kept.unshift(candidate)
        used = next
      }
      text = kept.join("\n\n")
    }
    if (!text) return { ok: false, reason: "tail truncated to empty" }
    return { ok: true, summaryText: text, kind: "replay-tail", truncated }
  }

  /**
   * Low-cost-server executor (kind 4). Triggers the `session.compact` plugin
   * hook. Today only the codex / openai plugin handles it (via
   * `/responses/compact`). Counts toward 5h burst quota but cheaper than a
   * full LLM round (kind 5).
   *
   * Returns the plugin's summary text without writing the anchor — anchor
   * write is the run() function's responsibility per DD-9. The legacy
   * `tryPluginCompaction` (still used by `process()`) writes its own anchor;
   * this is the de-coupled version for the new run() entry point.
   */
  async function tryLowCostServer(input: RunInput, model: Provider.Model | undefined): Promise<KindAttempt> {
    if (!model) return { ok: false, reason: "no resolvable model" }
    const msgs = await Session.messages({ sessionID: input.sessionID }).catch(() => undefined)
    if (!msgs || msgs.length === 0) return { ok: false, reason: "no messages" }
    const userMessage = msgs.findLast((m) => m.info.role === "user")?.info as MessageV2.User | undefined
    if (!userMessage) return { ok: false, reason: "no user message" }

    const conversationItems = buildConversationItemsForPlugin(msgs)
    if (conversationItems.length === 0) return { ok: false, reason: "no items to send" }

    const agent = await Agent.get(userMessage.agent ?? "default").catch(() => undefined)
    const instructions = (agent?.prompt ?? "").slice(0, 50000)

    let hookResult: { compactedItems: unknown[] | null; summary: string | null }
    try {
      hookResult = (await Plugin.trigger(
        "session.compact",
        {
          sessionID: input.sessionID,
          model: {
            providerId: model.providerId,
            modelID: model.id,
            accountId: userMessage.model.accountId,
          },
          conversationItems,
          instructions,
        },
        { compactedItems: null as unknown[] | null, summary: null as string | null },
      )) as { compactedItems: unknown[] | null; summary: string | null }
    } catch (err) {
      return {
        ok: false,
        reason: `plugin session.compact threw: ${err instanceof Error ? err.message : String(err)}`,
      }
    }

    if (!hookResult.compactedItems) return { ok: false, reason: "plugin did not handle" }
    const summaryText = hookResult.summary || "[Server-compacted conversation history]"
    return { ok: true, summaryText, kind: "low-cost-server" }
  }

  /**
   * Build the plugin-conversation-items shape from session messages. Lifted
   * from the legacy `tryPluginCompaction` body so the new low-cost-server
   * executor can stay decoupled from the legacy path. Phase 9 collapses
   * both call sites onto this single helper.
   */
  function buildConversationItemsForPlugin(msgs: MessageV2.WithParts[]): unknown[] {
    const items: unknown[] = []
    for (const msg of msgs) {
      if (msg.info.role === "user") {
        const textParts = msg.parts.filter((p) => p.type === "text")
        if (textParts.length > 0) {
          items.push({
            type: "message",
            role: "user",
            content: textParts.map((p) => ({ type: "input_text", text: (p as any).text ?? "" })),
          })
        }
      } else if (msg.info.role === "assistant") {
        const textParts = msg.parts.filter((p) => p.type === "text")
        if (textParts.length > 0) {
          items.push({
            type: "message",
            role: "assistant",
            content: textParts.map((p) => ({ type: "output_text", text: (p as any).text ?? "" })),
          })
        }
        for (const p of msg.parts) {
          if (p.type === "tool" && p.state.status === "completed") {
            items.push({
              type: "function_call",
              call_id: (p as any).toolCallId ?? p.id,
              name: p.tool,
              arguments:
                typeof (p as any).input === "string" ? (p as any).input : JSON.stringify((p as any).input ?? {}),
            })
            const stateOutput = p.state.output
            if (stateOutput != null && typeof stateOutput !== "string") {
              throw new Error(
                `compaction.run low-cost-server: tool ${p.tool} state.output is non-string (${typeof stateOutput}); ` +
                  `add an explicit unwrap before sending to plugin compact.`,
              )
            }
            items.push({
              type: "function_call_output",
              call_id: (p as any).toolCallId ?? p.id,
              output: stateOutput ?? "",
            })
          }
        }
      }
    }
    return items
  }

  /**
   * LLM-agent executor (kind 5). Phase 7b extraction: drives a full LLM
   * compaction round via SessionProcessor, returns the resulting summary
   * text. The assistant summary message + compaction part (i.e. the
   * Anchor) are written inline by this path because the LLM round
   * requires an already-persisted message to write parts into. Returns
   * with `anchorWritten: true` so run() skips the redundant _writeAnchor
   * call.
   *
   * Final fallback in the cost-monotonic chain. Most expensive: a full
   * LLM completion with the compaction agent's prompt template.
   */
  async function tryLlmAgent(input: RunInput, _model: Provider.Model | undefined): Promise<KindAttempt> {
    const messages = await Session.messages({ sessionID: input.sessionID }).catch(() => undefined)
    if (!messages || messages.length === 0) return { ok: false, reason: "no messages to compact" }
    const userMessage = messages.findLast((m) => m.info.role === "user")?.info as MessageV2.User | undefined
    if (!userMessage) return { ok: false, reason: "no user message" }
    const parentID = messages.at(-1)?.info.id
    if (!parentID) return { ok: false, reason: "empty stream" }

    try {
      const summaryText = await runLlmCompactionAgent({
        sessionID: input.sessionID,
        parentID,
        userMessage,
        messages,
        abort: input.abort ?? new AbortController().signal,
        // The auto flag controls Continue injection inside the legacy path,
        // but with phase 7b run() owns Continue injection — so always pass
        // false here. INJECT_CONTINUE[observed] in run() decides separately.
        auto: false,
      })
      if (!summaryText) return { ok: false, reason: "llm-agent produced empty summary" }
      return { ok: true, summaryText, kind: "llm-agent", anchorWritten: true }
    } catch (err) {
      return {
        ok: false,
        reason: `llm-agent threw: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }

  /**
   * Phase 7b: extracted LLM-round core from `process()`. Drives a full
   * compaction LLM call via SessionProcessor and writes the resulting
   * summary as an Anchor (assistant message with summary:true + compaction
   * part). Returns the summary text. Reused by both `tryLlmAgent` and the
   * legacy `process()` (which still owns Continue injection + checkpoint
   * save during the transition).
   */
  async function runLlmCompactionAgent(input: {
    sessionID: string
    parentID: string
    userMessage: MessageV2.User
    messages: MessageV2.WithParts[]
    abort: AbortSignal
    auto: boolean
  }): Promise<string | null> {
    Bus.publish(Event.CompactionStarted, { sessionID: input.sessionID, mode: "llm" })

    const agent = await Agent.get("compaction")
    log.info("triggering TRUE Summary Compaction (LLM agent)", { sessionID: input.sessionID })
    const model = agent.model
      ? await Provider.getModel(agent.model.providerId, agent.model.modelID)
      : await Provider.getModel(input.userMessage.model.providerId, input.userMessage.model.modelID)

    if (!canSummarize(model)) {
      log.warn("skipping LLM compaction: model context too small for meaningful summary", {
        sessionID: input.sessionID,
        modelID: model.id,
        contextLimit: model.limit?.context,
      })
      return null
    }

    const agentModel = agent.model as { accountId?: string } | undefined
    const session = await Session.get(input.sessionID)
    const accountId = agentModel?.accountId ?? input.userMessage.model.accountId ?? session?.execution?.accountId

    const msg = (await Session.updateMessage({
      id: Identifier.ascending("message"),
      role: "assistant",
      parentID: input.parentID,
      sessionID: input.sessionID,
      mode: "compaction",
      agent: "compaction",
      variant: input.userMessage.variant,
      summary: true,
      path: { cwd: Instance.directory, root: Instance.worktree },
      cost: 0,
      tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: model.id,
      providerId: model.providerId,
      accountId,
      time: { created: Date.now() },
    })) as MessageV2.Assistant

    const processor = SessionProcessor.create({
      assistantMessage: msg,
      sessionID: input.sessionID,
      model,
      accountId,
      abort: input.abort,
    })

    const compacting = await Plugin.trigger(
      "experimental.session.compacting",
      { sessionID: input.sessionID },
      { context: [], prompt: undefined },
    )
    const history = truncateModelMessagesForSmallContext({
      messages: input.messages,
      model,
      sessionID: input.sessionID,
    })
    const defaultPrompt = `Provide a detailed prompt for continuing our conversation above.
Focus on information that would be helpful for continuing the conversation, including what we did, what we're doing, which files we're working on, and what we're going to do next.
The summary that you construct will be used so that another agent can read it and continue the work.

When constructing the summary, try to stick to this template:
---
## Goal

[What goal(s) is the user trying to accomplish?]

## Instructions

- [What important instructions did the user give you that are relevant]
- [If there is a plan or spec, include information about it so next agent can continue using it]

## Discoveries

[What notable things were learned during this conversation that would be useful for the next agent to know when continuing the work]

## Accomplished

[What work has been completed, what work is still in progress, and what work is left?]

## Relevant files / directories

[Construct a structured list of relevant files that have been read, edited, or created that pertain to the task at hand. If all the files in a directory are relevant, include the path to the directory.]
---`
    const promptText = compacting.prompt ?? [defaultPrompt, ...compacting.context].join("\n\n")

    const result = await processor.process({
      user: input.userMessage,
      agent,
      abort: input.abort,
      sessionID: input.sessionID,
      tools: {},
      system: [],
      messages: sanitizeOrphanedToolCalls([
        ...history.messages,
        { role: "user", content: [{ type: "text", text: promptText }] },
      ]),
      model,
    })

    if (processor.message.error) return null
    if (result !== "continue") return null

    // Write the compaction boundary anchor on the summary assistant message.
    await Session.updatePart({
      id: Identifier.ascending("part"),
      messageID: processor.message.id,
      sessionID: input.sessionID,
      type: "compaction",
      auto: input.auto,
    })

    void publishCompactedAndResetChain(input.sessionID)

    // Read summary text out for the caller (and the checkpoint save below).
    const summaryMsg = (await Session.messages({ sessionID: input.sessionID })).findLast(
      (m) => m.info.id === processor.message.id,
    )
    const summaryText =
      summaryMsg?.parts
        .filter((p) => p.type === "text")
        .map((p) => (p as any).text ?? "")
        .join("\n") ?? ""

    // Phase 13.2-B: disk-file checkpoint write removed. The summary message
    // written above is the persisted record.

    return summaryText
  }

  async function tryKind(kind: KindName, input: RunInput, model: Provider.Model | undefined): Promise<KindAttempt> {
    switch (kind) {
      case "narrative":
        return tryNarrative(input, model)
      case "replay-tail":
        return tryReplayTail(input, model)
      case "low-cost-server":
        return tryLowCostServer(input, model)
      case "llm-agent":
        return tryLlmAgent(input, model)
    }
  }

  /**
   * Adapter: KIND_CHAIN entry → SessionCompaction.Hybrid.runHybridLlm.
   *
   * Pulls anchor / journal / pinned_zone / drop markers from
   * Memory.Hybrid accessors, computes the targetTokens budget from the
   * model's context window (DD-3: ~30% of context), invokes runHybridLlm,
   * maps the resulting CompactionEvent into a KindAttempt for the
   * existing KIND_CHAIN walker.
   *
   * Phase 2 dual-path strategy: only ever called when
   * Tweaks.compactionSync().enableHybridLlm === true (the master flag).
   * KIND_CHAIN's overflow / cache-aware / manual lists append "hybrid_llm"
   * at the FRONT when the flag is on; existing kinds remain reachable as
   * fallback if hybrid throws.
   */
  /**
   * Per-session in-flight registry. Prevents two concurrent hybrid_llm
   * enrichments on the same session. Cleared when the background
   * promise settles.
   */
  const hybridEnrichInFlight = new Map<string, Promise<unknown>>()

  /**
   * Background enrichment dispatch. Called AFTER the legacy KIND_CHAIN
   * has committed a fast intermediate anchor (typically narrative).
   * The user's runloop has already unblocked. This fires-and-forgets a
   * higher-quality LLM distillation that, when complete, writes a new
   * anchor superseding the legacy one (Memory.read picks most recent).
   *
   * If the flag is off, in-flight, or anchor is already small, skip.
   */
  function scheduleHybridEnrichment(sessionID: string, observed: Observed, model: Provider.Model | undefined): void {
    if (!model) return
    const tweaks = Tweaks.compactionSync()
    if (!tweaks.enableHybridLlm) return
    if (hybridEnrichInFlight.has(sessionID)) {
      log.info("hybrid_llm enrichment skipped (already in flight)", { sessionID })
      return
    }
    if (!new Set<Observed>(["overflow", "cache-aware", "manual"]).has(observed)) return

    const promise = (async () => {
      try {
        // STEP 1: capture the just-written narrative anchor (the chain's
        // fast intermediate). We will UPDATE this message's text part
        // when hybrid_llm finishes — same anchor position, upgraded
        // content. This preserves any user messages added during the
        // 30-60s background window (they stay post-anchor in journal).
        const messagesPre = await Session.messages({ sessionID }).catch(() => [] as MessageV2.WithParts[])
        const narrativeAnchorMsg = await Memory.Hybrid.getAnchorMessage(sessionID, messagesPre)
        if (!narrativeAnchorMsg) {
          log.warn("hybrid_llm enrichment: no anchor to enrich", { sessionID })
          return
        }
        const narrativeAnchorId = narrativeAnchorMsg.info.id
        const narrativeContent = narrativeAnchorMsg.parts
          .filter((p) => p.type === "text")
          .map((p) => (p as any).text ?? "")
          .join("\n")
        const narrativeTokens = Math.ceil(narrativeContent.length / 4)
        if (narrativeTokens < 5_000) {
          log.info("hybrid_llm enrichment skipped (anchor small)", {
            sessionID,
            anchorTokens: narrativeTokens,
          })
          return
        }
        const priorAnchor: Hybrid.Anchor = {
          role: "assistant",
          summary: true,
          content: narrativeContent,
          metadata: {
            anchorVersion: 1,
            generatedAt: new Date(narrativeAnchorMsg.info?.time?.created ?? Date.now()).toISOString(),
            generatedBy: {
              provider: (narrativeAnchorMsg.info as MessageV2.Assistant).providerId ?? "",
              model: (narrativeAnchorMsg.info as MessageV2.Assistant).modelID ?? "",
              accountId: (narrativeAnchorMsg.info as MessageV2.Assistant).accountId ?? "",
            },
            coversRounds: { earliest: 0, latest: 0 },
            inputTokens: 0,
            outputTokens: narrativeTokens,
            phase: 1,
          },
        }
        const ctx = model.limit?.context ?? 200_000
        const targetTokens = Math.max(5_000, Math.round(ctx * 0.3))

        // STEP 2: run hybrid_llm in background. It creates its OWN stub
        // anchor message (the SessionProcessor pattern requires a
        // persisted message to stream into). On success, the stub
        // contains the higher-quality body.
        const event = await Hybrid.runHybridLlm(sessionID, {
          abort: new AbortController().signal,
          priorAnchor,
          journalUnpinned: [],
          targetTokens,
          voluntary: false,
          busMode: "hybrid_llm_background",
        })
        log.info("hybrid_llm enrichment finished", {
          sessionID,
          eventId: event.eventId,
          result: event.result,
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          latencyMs: event.latencyMs,
          errorCode: event.errorCode,
        })
        if (event.result !== "success") {
          // hybrid_llm failed — narrative's anchor stays as the active
          // version. Nothing more to do.
          return
        }

        // STEP 3: read hybrid_llm's stub anchor body, then UPDATE the
        // narrative anchor in place. Demote the stub anchor (set
        // summary=false) so Memory.read no longer treats it as an
        // active anchor candidate.
        const messagesPost = await Session.messages({ sessionID }).catch(() => [] as MessageV2.WithParts[])
        // Find the stub: the most recent assistant+summary message.
        const stubIdx = (() => {
          for (let i = messagesPost.length - 1; i >= 0; i--) {
            const m = messagesPost[i]
            if (m.info?.role === "assistant" && (m.info as MessageV2.Assistant).summary === true) {
              return i
            }
          }
          return -1
        })()
        if (stubIdx === -1) {
          log.warn("hybrid_llm enrichment: stub anchor not found post-LLM", { sessionID })
          return
        }
        const stubMsg = messagesPost[stubIdx]
        if (stubMsg.info.id === narrativeAnchorId) {
          // No new stub was written (race / unexpected). Nothing to do.
          log.info("hybrid_llm enrichment: stub === narrative anchor, no upgrade needed", {
            sessionID,
          })
          return
        }
        // STALENESS CHECK: between the narrative anchor and the stub,
        // has anyone else written another anchor? If yes, the narrative
        // anchor is no longer the "previous" anchor relative to the
        // stub — abandon the in-place update to avoid corrupting
        // history. The stub stays as the new active anchor (which is
        // reasonable: it was distilled from a snapshot taken at start,
        // but the runtime will adapt on the next round).
        const narrativeIdx = messagesPost.findIndex((m) => m.info?.id === narrativeAnchorId)
        if (narrativeIdx === -1) {
          log.warn("hybrid_llm enrichment: narrative anchor disappeared", { sessionID })
          return
        }
        let interloperAnchorBetween = false
        for (let i = narrativeIdx + 1; i < stubIdx; i++) {
          const m = messagesPost[i]
          if (m.info?.role === "assistant" && (m.info as MessageV2.Assistant).summary === true) {
            interloperAnchorBetween = true
            break
          }
        }
        if (interloperAnchorBetween) {
          log.info("hybrid_llm enrichment: another compaction happened mid-flight; leaving stub as active anchor", {
            sessionID,
            narrativeAnchorId,
            stubId: stubMsg.info.id,
          })
          return
        }

        // Read stub's body
        const upgradedBody = stubMsg.parts
          .filter((p) => p.type === "text")
          .map((p) => (p as any).text ?? "")
          .join("\n")
        if (!upgradedBody.trim()) {
          log.warn("hybrid_llm enrichment: stub anchor has no text body; leaving narrative anchor unchanged", {
            sessionID,
          })
          return
        }

        // Update narrative anchor's text part(s) with the upgraded body.
        // Strategy: find narrative's first text part; overwrite its text
        // with the full upgraded body. If narrative had multiple text
        // parts, the others are left as-is — they don't matter because
        // Memory.read joins all text parts; the joined text will be
        // upgradedBody + leftover. To get a clean result, we'd need to
        // delete the leftover parts, but Storage doesn't support delete
        // directly. In practice narrative writes a single text part.
        const narrativeFresh = messagesPost[narrativeIdx]
        const narrativeTextPart = narrativeFresh.parts.find((p) => p.type === "text")
        if (!narrativeTextPart) {
          log.warn("hybrid_llm enrichment: narrative anchor has no text part to update", { sessionID })
          return
        }
        await Session.updatePart({
          ...(narrativeTextPart as any),
          text: upgradedBody,
        })

        // Demote the stub anchor: set summary=false so Memory.read no
        // longer picks it. The stub remains in stream as a hidden
        // compaction trace.
        await Session.updateMessage({
          ...(stubMsg.info as any),
          summary: false,
        })

        log.info("hybrid_llm enrichment: upgraded narrative anchor in place", {
          sessionID,
          narrativeAnchorId,
          stubId: stubMsg.info.id,
          upgradedTokens: Math.ceil(upgradedBody.length / 4),
          replacedTokens: narrativeTokens,
        })
      } catch (err) {
        log.error("hybrid_llm enrichment threw", {
          sessionID,
          error: err instanceof Error ? err.message : String(err),
        })
      } finally {
        hybridEnrichInFlight.delete(sessionID)
      }
    })()
    hybridEnrichInFlight.set(sessionID, promise)
    log.info("hybrid_llm enrichment scheduled (background)", {
      sessionID,
      observed,
    })
  }

  // Note: tryHybridLlmKind was removed 2026-04-29 in the redesign that
  // moved hybrid_llm out of KIND_CHAIN and into a background post-step
  // (see scheduleHybridEnrichment above). Keeping this comment as a
  // breadcrumb for git-blame archaeology — the function used to live
  // here.

  /**
   * Resolve the active model for a session via session.execution pin (set by
   * rotation3d / processor) or fall back to the most recent user-message
   * model. Returns undefined if the session is unknown.
   */
  async function resolveActiveModel(sessionID: string): Promise<Provider.Model | undefined> {
    const session = await Session.get(sessionID).catch(() => undefined)
    const exec = session?.execution
    const providerId = exec?.providerId
    const modelID = exec?.modelID
    if (!providerId || !modelID) return undefined
    return Provider.getModel(providerId, modelID).catch(() => undefined)
  }

  /**
   * Single entry point for every compaction execution.
   *
   * 1. Cooldown gate (DD-7): if Memory.lastCompactedAt < threshold rounds
   *    ago, return "continue" without doing anything (caller's runloop
   *    iteration proceeds to LLM call as normal).
   * 2. Walk KIND_CHAIN[observed] in order. Each kind transition emits a
   *    log.info per AGENTS.md rule 1.
   * 3. First kind that returns ok: write Anchor (compactWithSharedContext),
   *    optionally inject synthetic Continue per INJECT_CONTINUE[observed],
   *    return "continue" (the anchor message itself is the cooldown signal).
   * 4. Chain exhausted: log warn, return "stop".
   *
   * intent="rich" (only meaningful for observed=manual) skips kinds 1-3
   * and goes straight to llm-agent.
   */
  export async function run(input: RunInput): Promise<RunResult> {
    const { sessionID, observed, step } = input
    const intent = input.intent ?? "default"

    if (await Cooldown.shouldThrottle(sessionID)) {
      log.info("compaction.throttled", {
        sessionID,
        observed,
        step,
        cooldownMs: Cooldown.COOLDOWN_MS,
      })
      emitCompactionPredicateTelemetry({
        sessionID,
        step,
        outcome: "block",
        reason: "cooldown",
        observed,
      })
      return "continue"
    }

    log.info("compaction.started", { sessionID, observed, step, intent })

    // Fire the UI-visible "compaction starting" event NOW, before the kind
    // chain runs. The chain head is often `low-cost-server` (codex's own
    // server-side compact), which involves a 30-60s codex round-trip. The
    // per-kind emits inside compactWithSharedContext / tryLlmAgent / hybrid
    // only fire when their kind actually executes — meaning the toaster
    // could be invisible for the entire low-cost-server attempt. With this
    // upstream emit the toaster shows the moment we decide to compact, so
    // the user gets immediate feedback that "something is happening" and is
    // not staring at a frozen UI through the codex round-trip. Per-kind
    // emits stay (they mark which kind committed) — UI debounces.
    Bus.publish(Event.CompactionStarted, { sessionID, mode: "auto" })

    const model = await resolveActiveModel(sessionID)
    const ctxRatio = await sessionContextRatio(sessionID, model)
    const isSubscription = isSubscriptionCostModel(model)
    const baseChain = resolveKindChain({
      observed,
      providerId: model?.providerId,
      isSubscription,
      ctxRatio,
    })
    // Manual --rich: skip provider-aware chain and go straight to llm-agent.
    const chain: ReadonlyArray<KindName> =
      observed === "manual" && intent === "rich" ? (["llm-agent"] as const) : baseChain
    emitKindChainTelemetry({
      observed,
      providerId: model?.providerId,
      isSubscription,
      ctxRatio,
      codexServerPriorityRatio: Tweaks.compactionSync().codexServerPriorityRatio,
      chain,
    })

    // hybrid_llm post-step eligibility (specs/tool-output-chunking/
    // refactored 2026-04-29 04:50: hybrid_llm is NOT in the chain.
    // narrative remains chain head — fast, guaranteed anchor. After the
    // chain commits a fast intermediate anchor, if the operator opted
    // in via compaction_enable_hybrid_llm=1 AND no enrichment is
    // already in flight for this session, schedule a background
    // hybrid_llm distillation. Its higher-quality anchor supersedes
    // the chain's via Memory.read's most-recent-wins selection.
    //
    // Why the post-step approach (not in-chain): synchronous hybrid_llm
    // blocked the runloop 30-60s with no UI feedback (2026-04-29 first
    // production test). Background fall-through-to-narrative also
    // failed when narrative had insufficient turnSummaries. Putting
    // hybrid_llm AFTER chain success means we always have an anchor
    // before user is unblocked, regardless of whether hybrid_llm
    // succeeds or times out.
    const hybridEnrichmentEligible: ReadonlySet<Observed> = new Set(["overflow", "cache-aware", "manual"])

    const target = await resolveTargetPromptTokens()
    const hasPaidKindLater = (idx: number) => chain.slice(idx + 1).some((k) => !isLocalKind(k))

    for (let i = 0; i < chain.length; i++) {
      const kind = chain[i]
      const attempt = await tryKind(kind, input, model)
      log.info("compaction.kind_attempted", {
        sessionID,
        observed,
        kind,
        succeeded: attempt.ok,
        reason: attempt.ok ? undefined : attempt.reason,
      })
      if (attempt.ok) {
        // Double-phase escalation (DD-13): a LOCAL kind succeeded but had to
        // drop content to fit the target cap (`truncated: true`). If a paid
        // kind is available later in the chain, fall through and let it
        // re-compress intelligently — the local result was lossy. If no paid
        // kind remains, commit the truncated local result as best-effort.
        if (!attempt.anchorWritten && isLocalKind(attempt.kind) && attempt.truncated && hasPaidKindLater(i)) {
          const estimate = Math.ceil(attempt.summaryText.length / 4)
          log.info("compaction.local_truncated_escalating", {
            sessionID,
            observed,
            kind: attempt.kind,
            estimate,
            target,
          })
          continue
        }
        if (attempt.anchorWritten) {
          // Executor already wrote the anchor (tryLlmAgent uses an inline
          // SessionProcessor.process flow that requires a persisted message).
          // Skip _writeAnchor; still inject Continue + markCompacted below.
          if (INJECT_CONTINUE[observed]) {
            await injectContinueAfterAnchor(sessionID, observed)
          }
        } else if (model) {
          await _writeAnchor({
            sessionID,
            summaryText: attempt.summaryText,
            model,
            auto: INJECT_CONTINUE[observed],
            kind: attempt.kind,
          })
        } else {
          log.warn("compaction.run anchor write skipped: no resolvable model", { sessionID, observed })
        }
        // Phase 13.1: Memory.markCompacted call removed. The anchor message
        // written above (with `summary: true` and `time.created = now`) IS
        // the cooldown signal — Cooldown.shouldThrottle reads it directly.
        log.info("compaction.completed", {
          sessionID,
          observed,
          kind: attempt.kind,
          step,
        })
        // hybrid_llm post-step enrichment (Phase 2 redesigned 2026-04-29):
        // user is already unblocked because the chain just wrote a fast
        // intermediate anchor. If the operator opted in to hybrid_llm,
        // fire a background distillation that supersedes the chain's
        // anchor with a higher-quality one. Always non-blocking; failures
        // are logged but don't affect the runloop or the user.
        if (hybridEnrichmentEligible.has(observed)) {
          scheduleHybridEnrichment(sessionID, observed, model)
        }
        return "continue"
      }
    }

    log.warn("compaction.chain_exhausted", { sessionID, observed, step })
    return "stop"
  }

  /**
   * Phase 7b: inject the synthetic Continue user message after a kind-5
   * anchor write (where the executor wrote the anchor inline). Mirrors the
   * Continue injection behaviour of `compactWithSharedContext(auto:true)`,
   * factored out so run() controls Continue placement uniformly.
   */
  async function injectContinueAfterAnchor(sessionID: string, observed: Observed) {
    const messages = await Session.messages({ sessionID }).catch(() => [])
    const userMessage = messages.findLast((m) => m.info.role === "user")?.info as MessageV2.User | undefined
    if (!userMessage) {
      log.warn("compaction.run injectContinue: no user message found, skipping", { sessionID, observed })
      return
    }
    const continueMsg = await Session.updateMessage({
      id: Identifier.ascending("message"),
      role: "user",
      sessionID,
      time: { created: Date.now() },
      agent: userMessage.agent,
      model: userMessage.model,
      format: userMessage.format,
      variant: userMessage.variant,
    })
    await Session.updatePart({
      id: Identifier.ascending("part"),
      messageID: continueMsg.id,
      sessionID,
      type: "text",
      synthetic: true,
      text: "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.",
      time: { start: Date.now(), end: Date.now() },
    })
  }

  /**
   * Anchor-write indirection. Production wraps compactWithSharedContext; tests
   * can replace via `__test__.setAnchorWriter(fn)` to capture call arguments
   * without standing up the full Session/Bus/Storage stack.
   */
  type WriteAnchorInput = {
    sessionID: string
    summaryText: string
    model: Provider.Model
    auto: boolean
    kind: KindName
  }
  const defaultWriteAnchor = async (input: WriteAnchorInput) => {
    await compactWithSharedContext({
      sessionID: input.sessionID,
      snapshot: input.summaryText,
      model: input.model,
      auto: input.auto,
    })
  }
  let _writeAnchor: (input: WriteAnchorInput) => Promise<void> = defaultWriteAnchor

  /**
   * Test-only accessor. Exposes table literals + write-anchor injection so
   * tests can assert structure / capture invocation arguments without
   * re-defining tables or standing up the full Storage stack. Production
   * callers must not depend on these — they are implementation detail.
   */
  export const __test__ = Object.freeze({
    KIND_CHAIN,
    INJECT_CONTINUE,
    resolveKindChain,
    setAnchorWriter(fn: (input: WriteAnchorInput) => Promise<void>) {
      _writeAnchor = fn
    },
    resetAnchorWriter() {
      _writeAnchor = defaultWriteAnchor
    },
  })

  // ───────────────────────────────────────────────────────────────────
  // Hybrid sub-namespace — Phase 2 of context-management subsystem
  // (specs/tool-output-chunking/, refactor 2026-04-29).
  //
  // ALL Hybrid.* types and functions are additive during the flag-gated
  // dual-path rollout. The existing KIND_CHAIN above remains the active
  // path while `compaction_enable_hybrid_llm=0`. When the flag flips on,
  // hybrid_llm becomes the primary kind; the old kinds stay reachable
  // as fallback. Only after telemetry proves correctness does Phase 2.12
  // retire the old kinds.
  //
  // Type definitions mirror specs/tool-output-chunking/data-schema.json.
  // ───────────────────────────────────────────────────────────────────
  export namespace Hybrid {
    /**
     * Compaction phases. DD-3, DD-9. Phase 1 is the normal path; Phase 2
     * is a fail-safe absorbing pinned_zone. There is no Phase 3 (INV-6).
     */
    export type Phase = 1 | 2

    /**
     * LLM_compact internal mode. DD-3 internal mode — the caller does
     * not see this; it is a tactical input-size accommodation.
     */
    export type InternalMode = "single-pass" | "chunk-and-merge"

    /**
     * Source attribution for the budget value. Used in telemetry events
     * and debug logs to explain why a particular budget number was used.
     */
    export type BudgetSource = "ctx" | "tweaks-default" | "tweaks-task-override" | "tweaks-bash-override"

    /**
     * Anchor envelope. The canonical compaction output. On-disk shape is
     * still `assistant + summary === true` (compaction-redesign DD-8) so
     * legacy narrative anchors are forward-compatible. The body content
     * shape is provider-agnostic plain Markdown — see hybrid-llm-framing.md
     * §"Output validation" and INV-5.
     */
    export interface Anchor {
      role: "assistant"
      summary: true
      content: string
      metadata: AnchorMetadata
    }

    export interface AnchorMetadata {
      anchorVersion: 1
      generatedAt: string // ISO-8601
      generatedBy: { provider: string; model: string; accountId: string }
      coversRounds: { earliest: number; latest: number }
      inputTokens: number
      outputTokens: number
      phase: Phase
      internalMode?: InternalMode
    }

    /**
     * One round of raw conversation. Append-only inter-compaction (DD-1).
     * tool_call and tool_result must remain adjacent within `messages`
     * (provider validation requirement preserved by INV-4).
     */
    export interface JournalEntry {
      roundIndex: number
      // Native message-v2 messages — typed as unknown here to avoid a
      // circular-import dance with message-v2.ts; consumers cast to
      // MessageV2.WithParts when they need the structured shape.
      messages: unknown[]
    }

    /**
     * One pinned tool_result, materialised as a synthesised user-role
     * message envelope per DD-4 (closes G-1). Lives in pinned_zone, not
     * journal; the original tool_call/tool_result pair stays untouched
     * in journal.
     */
    export interface PinnedZoneEntry {
      role: "user"
      content: string // "[Pinned earlier output] tool '<name>' (round <K>, tool_call_id=<TID>) returned:\n<verbatim>"
      metadata: {
        pinSource: { toolCallId: string; toolName: string; roundIndex: number }
        tokens: number
        pinnedAt: string // ISO-8601
        pinnedBy: "ai" | "human"
      }
    }

    /**
     * AI/human override markers carried in assistant message metadata
     * (`message.metadata.contextMarkers`). Parsed pre-prompt-build (DD-15).
     */
    export interface ContextMarkers {
      pin?: string[] // tool_call ids → materialise into pinned_zone next prompt-build
      drop?: string[] // tool_call ids → exclude from next compaction's LLM_compact input
      recall?: { sessionId?: string; msgId: string }[] // re-load original disk content into journal tail
    }

    /**
     * Budget snapshot delivered to AI (R-5). Populated each prompt-build
     * round when Layer 3 visibility ships (Phase 3). Defined here because
     * the compaction subsystem produces these numbers.
     */
    export interface ContextStatus {
      totalBudget: number
      currentUsage: number
      roomRemaining: number
      anchorCoverageRounds: number
      journalDepthRounds: number
      pinnedZoneTokens?: number
      pinnedZoneCap?: number
    }

    /**
     * Input to LLM_compact. The runtime constructs this from session
     * state and serialises it into the actual chat-completion messages
     * (system + user) using the framing prompt template.
     */
    export interface LLMCompactRequest {
      priorAnchor: Anchor | null // null = cold-start
      journalUnpinned: JournalEntry[]
      pinnedZone?: PinnedZoneEntry[] // Phase 2 only
      dropMarkers?: string[]
      framing: { mode: "phase1" | "phase2"; strict: boolean }
      targetTokens: number
    }

    /**
     * Telemetry record per compaction event (R-13). Synchronous emit
     * before runloop continues (INV-7).
     */
    export interface CompactionEvent {
      eventId: string
      sessionId: string
      kind: "hybrid_llm"
      phase: Phase
      internalMode: InternalMode
      inputTokens: number
      outputTokens: number
      pinnedCountIn?: number
      pinnedCountOut?: number
      droppedCountIn?: number
      recallCountIn?: number
      voluntary?: boolean
      latencyMs: number
      costUsdEstimate?: number
      result: "success" | "failed_then_fallback" | "unrecoverable"
      errorCode?: ErrorCode | null
      emittedAt: string
    }

    /**
     * Error codes catalogued in specs/tool-output-chunking/errors.md.
     * Recovery semantics:
     * - FAILED / TIMEOUT / MALFORMED → graceful degradation per DD-6
     *   (keep prior anchor + truncate journal from oldest); runloop
     *   continues.
     * - OVERFLOW_UNRECOVERABLE → bounded chain exhausted (no Phase 3,
     *   INV-6); surfaced to user with remediation guidance.
     */
    export type ErrorCode =
      | "E_HYBRID_LLM_FAILED"
      | "E_HYBRID_LLM_TIMEOUT"
      | "E_HYBRID_LLM_MALFORMED"
      | "E_OVERFLOW_UNRECOVERABLE"

    // ─── Output validation (Phase 2.8) ────────────────────────────────
    // Mirrors hybrid-llm-framing.md §"Output validation" (DD-6 sanity).

    export type ValidationFailure =
      | "header_missing"
      | "size_overflow"
      | "sanity_smaller"
      | { kind: "forbidden_token"; token: string }
      | { kind: "drop_violated"; toolCallId: string }

    export interface ValidationResult {
      ok: boolean
      reason?: ValidationFailure
    }

    /**
     * The first line of any anchor body MUST match this format. The
     * timestamp / provider / model / round-range fields are placeholders;
     * runtime validates only the structural shape, not the values.
     */
    const ANCHOR_HEADER_RE = /^\[Context Anchor v1\] generated at \S+ by \S+:\S+ covering rounds \[\d+\.\.\d+\]/

    /**
     * Tokens that MUST NOT appear anywhere in the anchor body. Per
     * INV-5 — anchor must be portable across providers, so any
     * provider-specific control sequence or thinking-channel marker is
     * a contract violation.
     */
    const FORBIDDEN_TOKENS: readonly string[] = [
      "<thinking>",
      "</thinking>",
      "<scratchpad>",
      "</scratchpad>",
      "<|im_start|>",
      "<|im_end|>",
      '"tool_calls":',
      '"tool_use":',
    ]

    /**
     * Validate an anchor body returned by LLM_compact against the
     * contract in hybrid-llm-framing.md. Pure function, no side-effects.
     */
    export function validateAnchorBody(body: string, request: LLMCompactRequest): ValidationResult {
      // 1. Header present
      const firstLine = body.split("\n", 1)[0] ?? ""
      if (!ANCHOR_HEADER_RE.test(firstLine)) {
        return { ok: false, reason: "header_missing" }
      }
      // 2. Size <= targetTokens * 1.10 (10% slack for tokenizer drift)
      const ceil = Math.ceil(request.targetTokens * 1.1)
      const tokenEst = Math.ceil(body.length / 4)
      if (tokenEst > ceil) {
        return { ok: false, reason: "size_overflow" }
      }
      // 3. Strictly smaller than input
      const inputTokens = inputTokenEstimate(request)
      if (tokenEst >= inputTokens) {
        return { ok: false, reason: "sanity_smaller" }
      }
      // 4. No forbidden tokens
      for (const token of FORBIDDEN_TOKENS) {
        if (body.includes(token)) {
          return { ok: false, reason: { kind: "forbidden_token", token } }
        }
      }
      // 5. Drop respected (if dropMarkers present, none of those ids appear)
      if (request.dropMarkers && request.dropMarkers.length > 0) {
        for (const id of request.dropMarkers) {
          if (id && body.includes(id)) {
            return { ok: false, reason: { kind: "drop_violated", toolCallId: id } }
          }
        }
      }
      return { ok: true }
    }

    /**
     * Approximate input size (tokens) of an LLMCompactRequest. Used for
     * sanity check (output must be smaller than input) and for choosing
     * single-pass vs chunk-and-merge mode.
     */
    export function inputTokenEstimate(request: LLMCompactRequest): number {
      const charCount =
        (request.priorAnchor?.content.length ?? 0) +
        request.journalUnpinned.reduce((sum, je) => {
          // Rough estimate: each message ~200 chars on average is too low;
          // serialise as JSON for a more honest count.
          try {
            return sum + JSON.stringify(je.messages).length
          } catch {
            return sum
          }
        }, 0) +
        (request.pinnedZone?.reduce((sum, p) => sum + p.content.length, 0) ?? 0)
      return Math.ceil(charCount / 4)
    }

    // ─── Framing prompt (lazy-loaded) ─────────────────────────────────

    let _framingTemplate: string | null = null
    /**
     * Load the runtime framing prompt template from
     * packages/opencode/src/session/prompt/hybrid-llm-framing.md (Phase
     * 2.1 git-mv'd). Lazy + cached because compaction fires sparsely; no
     * point keeping it resident for sessions that never compact.
     */
    export async function loadFramingTemplate(): Promise<string> {
      if (_framingTemplate !== null) return _framingTemplate
      const url = new URL("./prompt/hybrid-llm-framing.md", import.meta.url)
      try {
        const text = await Bun.file(url.pathname).text()
        _framingTemplate = text
        return text
      } catch (err) {
        log.warn("hybrid-llm-framing.md not loadable", {
          path: url.pathname,
          error: err instanceof Error ? err.message : String(err),
        })
        // Fallback to an inlined minimal prompt so production never wedges
        // on a packaging error. The minimal prompt enforces the same
        // contract; the real prompt is just richer.
        _framingTemplate = INLINE_MINIMAL_FRAMING
        return _framingTemplate
      }
    }

    const INLINE_MINIMAL_FRAMING = `You are the Context Compactor.
Output a single Markdown summary distilling PRIOR_ANCHOR + JOURNAL.
First line MUST be: [Context Anchor v1] generated at <ISO-8601> by <provider>:<model> covering rounds [<earliest>..<latest>]
Body: plain Markdown only. NO <thinking>, no provider tokens, no tool_call/tool_result JSON.
Target size: at most {{targetTokens}} tokens.
Honour DROP_MARKERS: do not mention dropped tool_call ids.
{{phase2Strict}}`

    /**
     * Build the user-payload text for an LLMCompactRequest, populating
     * the META block + PRIOR_ANCHOR + JOURNAL + (optional) PINNED_ZONE.
     * Pure function; no side-effects.
     */
    export function buildUserPayload(
      request: LLMCompactRequest,
      meta: { generatedAt: string; provider: string; model: string },
    ): string {
      const earliest = request.journalUnpinned[0] ? (request.journalUnpinned[0].roundIndex ?? 0) : 0
      const latest =
        request.journalUnpinned.length > 0
          ? (request.journalUnpinned[request.journalUnpinned.length - 1].roundIndex ?? earliest)
          : earliest
      const lines: string[] = [
        "META:",
        `  generated_at: ${meta.generatedAt}`,
        `  provider: ${meta.provider}`,
        `  model: ${meta.model}`,
        `  rounds_covered: [${earliest}..${latest}]`,
        `  target_tokens: ${request.targetTokens}`,
        `  phase: ${request.framing.mode === "phase2" ? 2 : 1}`,
        "",
        "PRIOR_ANCHOR:",
        request.priorAnchor?.content ?? "(none — cold start)",
        "",
        `JOURNAL (rounds ${earliest}..${latest}):`,
      ]
      for (const je of request.journalUnpinned) {
        lines.push(`--- round ${je.roundIndex} ---`)
        try {
          lines.push(JSON.stringify(je.messages, null, 2))
        } catch {
          lines.push("(unserialisable round)")
        }
      }
      if (request.dropMarkers && request.dropMarkers.length > 0) {
        lines.push("")
        lines.push(`DROP_MARKERS: ${request.dropMarkers.join(", ")}`)
      }
      if (request.framing.mode === "phase2" && request.pinnedZone && request.pinnedZone.length > 0) {
        lines.push("")
        lines.push("PINNED_ZONE:")
        for (const p of request.pinnedZone) {
          lines.push(
            `--- pinned: tool '${p.metadata.pinSource.toolName}' (round ${p.metadata.pinSource.roundIndex}, id=${p.metadata.pinSource.toolCallId}) ---`,
          )
          lines.push(p.content)
        }
      }
      lines.push("")
      lines.push("Produce the new anchor body now.")
      return lines.join("\n")
    }

    // ─── runLlmCompactChunkAndMerge (Phase 2.7 internal mode) ─────────

    /**
     * Cold-start path: when a single LLM_compact call's input would
     * exceed the model's per-request budget (typically 200K-round
     * legacy sessions with no anchor yet), split journal into chunks
     * and build the digest sequentially. Each iteration's priorAnchor
     * is the previous iteration's output digest.
     *
     * Internal mode (DD-3) — externally still appears as 'hybrid_llm';
     * the difference shows up only in the CompactionEvent's
     * internalMode='chunk-and-merge' field for telemetry.
     *
     * Walks journal in chunks sized to fit `llmInputBudget`. Last
     * chunk's output is the final anchor body, written via the same
     * SessionProcessor pattern as single-pass. Validation runs only on
     * the FINAL digest — intermediate digests are internal scratch.
     */
    async function runLlmCompactChunkAndMerge(
      sessionID: string,
      request: LLMCompactRequest,
      opts: { abort: AbortSignal },
      ctx: {
        model: Provider.Model
        parentID: string
        userMessage: MessageV2.User
        accountId?: string
        systemText: string
        llmInputBudget: number
        startedAt: number
      },
    ): Promise<LlmCompactResult> {
      log.info("hybrid_llm chunk-and-merge entering", {
        sessionID,
        journalRounds: request.journalUnpinned.length,
        llmInputBudget: ctx.llmInputBudget,
        priorAnchorTokens: request.priorAnchor ? Math.ceil(request.priorAnchor.content.length / 4) : 0,
      })

      // Estimate per-round token cost for chunk sizing. Average over the
      // journal so a few outlier-large rounds don't tank the chunk size.
      const perRoundEst =
        request.journalUnpinned.length > 0
          ? Math.max(
              500,
              Math.ceil(
                request.journalUnpinned.reduce((sum, je) => {
                  try {
                    return sum + JSON.stringify(je.messages).length
                  } catch {
                    return sum
                  }
                }, 0) /
                  request.journalUnpinned.length /
                  4,
              ),
            )
          : 500
      // Reserve room for the running digest (assumed ≤ targetTokens) +
      // framing overhead. Each chunk gets the rest.
      const chunkBudget = Math.max(2_000, ctx.llmInputBudget - request.targetTokens - 1_000)
      const roundsPerChunk = Math.max(1, Math.floor(chunkBudget / perRoundEst))

      let runningDigest: Anchor | null = request.priorAnchor
      const chunks: JournalEntry[][] = []
      for (let i = 0; i < request.journalUnpinned.length; i += roundsPerChunk) {
        chunks.push(request.journalUnpinned.slice(i, i + roundsPerChunk))
      }
      log.info("hybrid_llm chunk-and-merge plan", {
        sessionID,
        totalChunks: chunks.length,
        roundsPerChunk,
        perRoundEst,
      })

      // Last chunk index — only that one's anchor message gets persisted
      // to the stream; intermediates are LLM-only scratch.
      const lastIdx = chunks.length - 1
      let finalAnchorBody = ""
      let finalMessageId = ""

      for (let i = 0; i < chunks.length; i++) {
        const isLast = i === lastIdx
        const chunkRequest: LLMCompactRequest = {
          priorAnchor: runningDigest,
          journalUnpinned: chunks[i],
          framing: { mode: "phase1", strict: false },
          targetTokens: request.targetTokens,
        }
        const userText = buildUserPayload(chunkRequest, {
          generatedAt: new Date().toISOString(),
          provider: ctx.model.providerId ?? ctx.userMessage.model.providerId,
          model: ctx.model.id ?? ctx.userMessage.model.modelID,
        })

        if (isLast) {
          // Persist as the actual anchor message via SessionProcessor.
          const stub = (await Session.updateMessage({
            id: Identifier.ascending("message"),
            role: "assistant",
            parentID: ctx.parentID,
            sessionID,
            mode: "compaction",
            agent: "compaction",
            variant: ctx.userMessage.variant,
            summary: true,
            path: { cwd: Instance.directory, root: Instance.worktree },
            cost: 0,
            tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: ctx.model.id,
            providerId: ctx.model.providerId,
            accountId: ctx.accountId,
            time: { created: Date.now() },
          } as any)) as MessageV2.Assistant
          const processor = SessionProcessor.create({
            assistantMessage: stub,
            sessionID,
            model: ctx.model,
            accountId: ctx.accountId,
            abort: opts.abort,
          })
          try {
            const result = await processor.process({
              user: ctx.userMessage,
              agent: await Agent.get("compaction"),
              abort: opts.abort,
              sessionID,
              tools: {},
              system: [ctx.systemText],
              messages: sanitizeOrphanedToolCalls([{ role: "user", content: [{ type: "text", text: userText }] }]),
              model: ctx.model,
            })
            if (processor.message.error || result !== "continue") {
              return {
                ok: false,
                reason: "llm_threw",
                detail: processor.message.error ? "processor reported error" : `result=${result}`,
                latencyMs: Date.now() - ctx.startedAt,
              }
            }
          } catch (err) {
            return {
              ok: false,
              reason: "llm_threw",
              detail: err instanceof Error ? err.message : String(err),
              latencyMs: Date.now() - ctx.startedAt,
            }
          }
          const fresh = (await Session.messages({ sessionID })).findLast((m) => m.info.id === processor.message.id)
          finalAnchorBody =
            fresh?.parts
              .filter((p) => p.type === "text")
              .map((p) => (p as any).text ?? "")
              .join("\n") ?? ""
          finalMessageId = processor.message.id
        } else {
          // Intermediate chunk — call the LLM but DON'T persist the
          // result as a session anchor. Use a throwaway processor.
          // (Implementation note: the simplest way to get a one-shot
          // LLM call without session-mutation in opencode is to still
          // create+drop a stub message. We do it but mark the result
          // for cleanup. For now this is a pragmatic shortcut — a
          // future refactor could expose a lower-level Provider call.)
          const stub = (await Session.updateMessage({
            id: Identifier.ascending("message"),
            role: "assistant",
            parentID: ctx.parentID,
            sessionID,
            mode: "compaction",
            agent: "compaction-chunk",
            variant: ctx.userMessage.variant,
            summary: true, // mark to keep prompt-build behaviour consistent
            path: { cwd: Instance.directory, root: Instance.worktree },
            cost: 0,
            tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: ctx.model.id,
            providerId: ctx.model.providerId,
            accountId: ctx.accountId,
            time: { created: Date.now() },
          } as any)) as MessageV2.Assistant
          const processor = SessionProcessor.create({
            assistantMessage: stub,
            sessionID,
            model: ctx.model,
            accountId: ctx.accountId,
            abort: opts.abort,
          })
          try {
            await processor.process({
              user: ctx.userMessage,
              agent: await Agent.get("compaction"),
              abort: opts.abort,
              sessionID,
              tools: {},
              system: [ctx.systemText],
              messages: sanitizeOrphanedToolCalls([{ role: "user", content: [{ type: "text", text: userText }] }]),
              model: ctx.model,
            })
          } catch (err) {
            return {
              ok: false,
              reason: "llm_threw",
              detail: `chunk ${i}: ${err instanceof Error ? err.message : String(err)}`,
              latencyMs: Date.now() - ctx.startedAt,
            }
          }
          const fresh = (await Session.messages({ sessionID })).findLast((m) => m.info.id === processor.message.id)
          const intermediateBody =
            fresh?.parts
              .filter((p) => p.type === "text")
              .map((p) => (p as any).text ?? "")
              .join("\n") ?? ""
          // Use intermediate as next iteration's priorAnchor.
          runningDigest = {
            role: "assistant",
            summary: true,
            content: intermediateBody,
            metadata: {
              anchorVersion: 1,
              generatedAt: new Date().toISOString(),
              generatedBy: {
                provider: ctx.model.providerId ?? "",
                model: ctx.model.id ?? "",
                accountId: ctx.accountId ?? "",
              },
              coversRounds: { earliest: 0, latest: chunks[i].length },
              inputTokens: 0,
              outputTokens: Math.ceil(intermediateBody.length / 4),
              phase: 1,
              internalMode: "chunk-and-merge",
            },
          }
        }
      }

      const validation = validateAnchorBody(finalAnchorBody, request)
      if (!validation.ok) {
        return {
          ok: false,
          reason: validation.reason ?? "header_missing",
          detail: typeof validation.reason === "string" ? validation.reason : JSON.stringify(validation.reason),
          latencyMs: Date.now() - ctx.startedAt,
        }
      }
      log.info("hybrid_llm chunk-and-merge completed", {
        sessionID,
        chunks: chunks.length,
        finalBodyTokens: Math.ceil(finalAnchorBody.length / 4),
      })
      // Note: Bus.publish(Compacted) handled by runLlmCompact wrapper's
      // finally block — fires on every exit path including chunk-and-merge.
      return {
        ok: true,
        anchorBody: finalAnchorBody,
        anchorMessageId: finalMessageId,
        latencyMs: Date.now() - ctx.startedAt,
        provider: ctx.model.providerId ?? "",
        model: ctx.model.id ?? "",
      }
    }

    // ─── runLlmCompact (Phase 2.6 single-pass core) ───────────────────

    /**
     * Result of a single LLM_compact attempt. Caller (runHybridLlm,
     * Phase 2.9) decides retry / fallback / degradation based on this.
     */
    export type LlmCompactResult =
      | { ok: true; anchorBody: string; anchorMessageId: string; latencyMs: number; provider: string; model: string }
      | {
          ok: false
          reason: ValidationFailure | "llm_threw" | "no_response" | "timeout"
          detail?: string
          latencyMs: number
        }

    /**
     * Single-pass LLM_compact. Builds the framing prompt + user payload
     * from `request`, dispatches a compaction LLM round, validates the
     * returned anchor body. NO retry logic — that lives one layer up in
     * runHybridLlm.
     *
     * Mirrors runLlmCompactionAgent's session-mutation pattern: creates
     * an assistant message stub (will become the anchor), runs the
     * processor, reads the resulting text part. The caller (runHybridLlm)
     * is responsible for writing the compaction part once validation
     * passes — that way a failed validation does NOT leave a partial
     * anchor in the stream.
     *
     * Phase 2.7 (chunk-and-merge) is a TODO — this function throws
     * `chunk_and_merge_unimplemented` when the input exceeds the LLM's
     * input budget. The graceful-degradation path in runHybridLlm
     * catches and falls back.
     */
    export async function runLlmCompact(
      sessionID: string,
      request: LLMCompactRequest,
      opts: {
        abort: AbortSignal
        stricterRetryReason?: ValidationFailure
        /** UI label for Bus.publish(CompactionStarted/Compacted). */
        busMode?: "hybrid_llm" | "hybrid_llm_background"
      },
    ): Promise<LlmCompactResult> {
      // Visibility — TUI / web shows "Compacting..." badge from this event.
      // Defaults to 'hybrid_llm' (foreground) unless caller specifies background.
      Bus.publish(Event.CompactionStarted, { sessionID, mode: opts.busMode ?? "hybrid_llm" })
      try {
        return await runLlmCompactInner(sessionID, request, opts)
      } finally {
        // Always dismiss the UI toast AND reset codex chain, even on
        // failure / timeout. Subscribers that need success/failure
        // discrimination should look at the LlmCompactResult.ok flag
        // returned to the caller.
        void publishCompactedAndResetChain(sessionID)
      }
    }

    async function runLlmCompactInner(
      sessionID: string,
      request: LLMCompactRequest,
      opts: {
        abort: AbortSignal
        stricterRetryReason?: ValidationFailure
        busMode?: "hybrid_llm" | "hybrid_llm_background"
      },
    ): Promise<LlmCompactResult> {
      const startedAt = Date.now()
      // Reset codex's per-session chain BEFORE dispatching the compaction
      // LLM call. If we wait for the finally block in runLlmCompact, this
      // call inherits the previous turn's lastResponseId — and that chain
      // is exactly what overflowed in the first place. Sending the
      // compaction prompt atop a stale chain reproduces the same
      // "exceeds context window" error a second time, which the user
      // sees as the duplicate display. Idempotent: the finally block
      // still fires, no harm in calling twice.
      try {
        const { invalidateContinuationFamily } = await import("@opencode-ai/codex-provider/continuation")
        invalidateContinuationFamily(sessionID)
      } catch {
        // best-effort; non-codex providers don't expose this module
      }
      const messages = await Session.messages({ sessionID }).catch(() => undefined)
      if (!messages || messages.length === 0) {
        return { ok: false, reason: "no_response", detail: "empty stream", latencyMs: Date.now() - startedAt }
      }
      const userMessage = messages.findLast((m) => m.info.role === "user")?.info as MessageV2.User | undefined
      if (!userMessage) {
        return { ok: false, reason: "no_response", detail: "no user message", latencyMs: Date.now() - startedAt }
      }
      const parentID = messages.at(-1)?.info.id
      if (!parentID) {
        return { ok: false, reason: "no_response", detail: "no parent id", latencyMs: Date.now() - startedAt }
      }

      const agent = await Agent.get("compaction")
      const agentModel = agent.model as { accountId?: string } | undefined
      const session = await Session.get(sessionID)
      // Prefer session.execution (the FRONTEND-CURRENT account) over the
      // last user message's stored account. After rate-limit rotation,
      // session.execution points to the new account but userMessage's
      // stored account is whatever was active when the user sent that
      // message (often the rotated-out, throttled one). Compaction
      // should follow what the frontend is using NOW.
      const exec = session?.execution
      const model = agent.model
        ? await Provider.getModel(agent.model.providerId, agent.model.modelID)
        : exec?.providerId && exec?.modelID
          ? await Provider.getModel(exec.providerId, exec.modelID)
          : await Provider.getModel(userMessage.model.providerId, userMessage.model.modelID)
      if (!canSummarize(model)) {
        return {
          ok: false,
          reason: "no_response",
          detail: `model ${model.id} context too small to compact`,
          latencyMs: Date.now() - startedAt,
        }
      }

      // Build the chat-completion payload. Framing template is the
      // system message; user payload renders the request. Computed
      // up-front so chunk-and-merge dispatch (below) can re-use them.
      const framingRaw = await loadFramingTemplate()
      const framing = applyFramingPlaceholders(framingRaw, {
        targetTokens: request.targetTokens,
        phase2Strict: request.framing.strict
          ? "PHASE 2 STRICT MODE — emergency framing. Be ruthless: drop secondary detail. Hard ceiling at the listed target_tokens."
          : "",
      })
      const stricterAddendum = opts.stricterRetryReason
        ? "\n\nPREVIOUS ATTEMPT FAILED VALIDATION:\n- Reason: " +
          stricterReasonText(opts.stricterRetryReason) +
          "\nYou must comply with the OUTPUT SHAPE and TARGET SIZE rules exactly. Reduce detail; cut secondary content; halve the size if necessary. Begin with the header line and produce nothing else.\n"
        : ""
      const systemText = framing + stricterAddendum
      // Account priority (mirrors model resolution above): the
      // frontend-current account from session.execution wins. Falls
      // back to compaction agent's account, then user message account.
      const accountId = agentModel?.accountId ?? exec?.accountId ?? userMessage.model.accountId

      // Phase 2.7 chunk-and-merge: when single-pass input exceeds the
      // LLM's per-request budget, switch to sequential digest building.
      // Walk journal in chunks; each chunk's LLM_compact takes the
      // running digest as priorAnchor + chunk_k as journal. Final digest
      // is returned as the new anchor body. Internal mode — caller does
      // not see this (DD-3).
      const inputTokens = inputTokenEstimate(request)
      const llmInputBudget = (model.limit?.context ?? 200_000) - request.targetTokens - 4_000 // safety margin
      if (inputTokens > llmInputBudget) {
        return runLlmCompactChunkAndMerge(sessionID, request, opts, {
          model,
          parentID,
          userMessage,
          accountId,
          systemText,
          llmInputBudget,
          startedAt,
        })
      }

      const userText = buildUserPayload(request, {
        generatedAt: new Date().toISOString(),
        provider: model.providerId ?? userMessage.model.providerId,
        model: model.id ?? userMessage.model.modelID,
      })

      // Stub assistant message in the stream — becomes the anchor when
      // validation passes. If validation fails we still leave the message
      // (it has the failed body) and the caller may either delete it or
      // overwrite on retry. For simplicity in this initial cut we leave
      // it; a follow-up will clean up failed-attempt anchors.
      const stub = (await Session.updateMessage({
        id: Identifier.ascending("message"),
        role: "assistant",
        parentID,
        sessionID,
        mode: "compaction",
        agent: "compaction",
        variant: userMessage.variant,
        summary: true,
        path: { cwd: Instance.directory, root: Instance.worktree },
        cost: 0,
        tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: model.id,
        providerId: model.providerId,
        accountId,
        time: { created: Date.now() },
      } as any)) as MessageV2.Assistant

      // Wire timeout: combine caller's abort with a timeout-driven one
      // so the LLM call gets aborted at compaction_llm_timeout_ms (DD-6).
      const timeoutMs = Tweaks.compactionSync().llmTimeoutMs
      const timeoutCtl = new AbortController()
      const timeoutTimer = setTimeout(() => timeoutCtl.abort(), timeoutMs)
      const combinedAbort = AbortSignal.any([opts.abort, timeoutCtl.signal])

      const processor = SessionProcessor.create({
        assistantMessage: stub,
        sessionID,
        model,
        accountId,
        abort: combinedAbort,
      })

      try {
        const result = await processor.process({
          user: userMessage,
          agent,
          abort: combinedAbort,
          sessionID,
          tools: {},
          system: [systemText],
          messages: sanitizeOrphanedToolCalls([{ role: "user", content: [{ type: "text", text: userText }] }]),
          model,
        })
        if (processor.message.error || result !== "continue") {
          clearTimeout(timeoutTimer)
          if (timeoutCtl.signal.aborted) {
            return {
              ok: false,
              reason: "timeout",
              detail: `LLM compaction exceeded ${timeoutMs}ms`,
              latencyMs: Date.now() - startedAt,
            }
          }
          return {
            ok: false,
            reason: "llm_threw",
            detail: processor.message.error ? "processor reported error" : `result=${result}`,
            latencyMs: Date.now() - startedAt,
          }
        }
      } catch (err) {
        clearTimeout(timeoutTimer)
        if (timeoutCtl.signal.aborted) {
          return {
            ok: false,
            reason: "timeout",
            detail: `LLM compaction exceeded ${timeoutMs}ms`,
            latencyMs: Date.now() - startedAt,
          }
        }
        return {
          ok: false,
          reason: "llm_threw",
          detail: err instanceof Error ? err.message : String(err),
          latencyMs: Date.now() - startedAt,
        }
      }
      clearTimeout(timeoutTimer)

      // Read assistant text out
      const fresh = (await Session.messages({ sessionID })).findLast((m) => m.info.id === processor.message.id)
      const anchorBody =
        fresh?.parts
          .filter((p) => p.type === "text")
          .map((p) => (p as any).text ?? "")
          .join("\n") ?? ""

      const validation = validateAnchorBody(anchorBody, request)
      if (!validation.ok) {
        return {
          ok: false,
          reason: validation.reason ?? "header_missing",
          detail: typeof validation.reason === "string" ? validation.reason : JSON.stringify(validation.reason),
          latencyMs: Date.now() - startedAt,
        }
      }

      // Note: Bus.publish(Compacted) handled by runLlmCompact wrapper's
      // finally block — fires on every exit path (success/failure/timeout).

      return {
        ok: true,
        anchorBody,
        anchorMessageId: processor.message.id,
        latencyMs: Date.now() - startedAt,
        provider: model.providerId ?? "",
        model: model.id ?? "",
      }
    }

    function applyFramingPlaceholders(template: string, vars: { targetTokens: number; phase2Strict: string }): string {
      return template
        .replaceAll("{{targetTokens}}", String(vars.targetTokens))
        .replaceAll("{{phase2Strict}}", vars.phase2Strict)
        .replaceAll("{{phase2TargetTokens}}", String(vars.targetTokens))
    }

    function stricterReasonText(reason: ValidationFailure): string {
      if (typeof reason === "string") {
        switch (reason) {
          case "header_missing":
            return "first line did not match [Context Anchor v1] header regex"
          case "size_overflow":
            return "output exceeded targetTokens * 1.10 ceiling"
          case "sanity_smaller":
            return "output was not smaller than input (likely a verbatim echo)"
          default:
            return reason
        }
      }
      if (reason.kind === "forbidden_token") return `forbidden token present: ${reason.token}`
      if (reason.kind === "drop_violated") return `dropped tool_call_id appeared verbatim: ${reason.toolCallId}`
      return JSON.stringify(reason)
    }

    // ─── runHybridLlm (Phase 2.9 recovery wrapper, MINIMAL) ────────────

    /**
     * Top-level entry for the hybrid-llm compaction path. Wraps
     * runLlmCompact with a minimal recovery ladder:
     *
     *   1. First attempt with normal framing.
     *   2. Single retry with stricter framing (includes the
     *      validation-failure reason as a prompt addendum).
     *   3. (TODO Phase 2.9 follow-up): optional fallback provider.
     *   4. Graceful degradation: keep prior anchor; do NOT write a new
     *      one. The runloop continues; next overflow trigger will retry.
     *
     * Phase 2 absorb-pinned-zone path (DD-5/DD-9) and starvation
     * handling (E_OVERFLOW_UNRECOVERABLE) are TODO Phase 2.10/2.11 — for
     * now this function only fires Phase 1.
     *
     * Returns a CompactionEvent describing what happened. Callers emit
     * the event into telemetry (Phase 2.13) and decide downstream
     * actions.
     */
    export async function runHybridLlm(
      sessionID: string,
      opts: {
        abort: AbortSignal
        priorAnchor: Anchor | null
        journalUnpinned: JournalEntry[]
        pinnedZone?: PinnedZoneEntry[]
        dropMarkers?: string[]
        targetTokens: number
        voluntary?: boolean
        busMode?: "hybrid_llm" | "hybrid_llm_background"
      },
    ): Promise<CompactionEvent> {
      const eventId = `cev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
      const startedAt = Date.now()
      const request: LLMCompactRequest = {
        priorAnchor: opts.priorAnchor,
        journalUnpinned: opts.journalUnpinned,
        pinnedZone: opts.pinnedZone,
        dropMarkers: opts.dropMarkers,
        framing: { mode: "phase1", strict: false },
        targetTokens: opts.targetTokens,
      }

      // Attempt 1
      const first = await runLlmCompact(sessionID, request, { abort: opts.abort, busMode: opts.busMode })
      if (first.ok) {
        return makeEvent({
          eventId,
          sessionID,
          phase: 1,
          internalMode: "single-pass",
          inputTokens: inputTokenEstimate(request),
          outputTokens: Math.ceil(first.anchorBody.length / 4),
          pinnedCountIn: opts.pinnedZone?.length,
          droppedCountIn: opts.dropMarkers?.length,
          recallCountIn: 0,
          voluntary: opts.voluntary,
          latencyMs: Date.now() - startedAt,
          result: "success",
        })
      }

      // Attempt 2 — stricter framing if the failure was validation-shaped.
      const isValidationShaped =
        first.reason === "header_missing" ||
        first.reason === "size_overflow" ||
        first.reason === "sanity_smaller" ||
        (typeof first.reason === "object" &&
          (first.reason.kind === "forbidden_token" || first.reason.kind === "drop_violated"))
      if (isValidationShaped) {
        const second = await runLlmCompact(sessionID, request, {
          abort: opts.abort,
          stricterRetryReason: first.reason as ValidationFailure,
          busMode: opts.busMode,
        })
        if (second.ok) {
          return makeEvent({
            eventId,
            sessionID,
            phase: 1,
            internalMode: "single-pass",
            inputTokens: inputTokenEstimate(request),
            outputTokens: Math.ceil(second.anchorBody.length / 4),
            pinnedCountIn: opts.pinnedZone?.length,
            droppedCountIn: opts.dropMarkers?.length,
            recallCountIn: 0,
            voluntary: opts.voluntary,
            latencyMs: Date.now() - startedAt,
            result: "success",
          })
        }
      }

      // Phase 2 absorb-pinned-zone path (2.10, DD-5/DD-9). Triggers when:
      //   (a) Phase 1 attempts both failed AND pinned_zone is non-empty
      //       (absorbing it might reduce input enough to fit), OR
      //   (b) Phase 1 succeeded but the resulting prompt is still over
      //       budget (caller responsibility — not detected here).
      // For (a) we attempt Phase 2 with stricter framing and an
      // absorbed pinned_zone. Telemetry records phase2_fired=true via
      // the phase=2 field in CompactionEvent.
      if (opts.pinnedZone && opts.pinnedZone.length > 0) {
        const phase2TargetTokens = Tweaks.compactionSync().phase2MaxAnchorTokens
        const phase2Request: LLMCompactRequest = {
          priorAnchor: opts.priorAnchor,
          journalUnpinned: opts.journalUnpinned,
          pinnedZone: opts.pinnedZone,
          dropMarkers: opts.dropMarkers,
          framing: { mode: "phase2", strict: true },
          targetTokens: phase2TargetTokens,
        }
        log.info("hybrid-llm Phase 2 firing (absorbing pinned_zone)", {
          sessionID,
          pinnedCount: opts.pinnedZone.length,
          phase2TargetTokens,
        })
        const phase2 = await runLlmCompact(sessionID, phase2Request, { abort: opts.abort, busMode: opts.busMode })
        if (phase2.ok) {
          // Pinned_zone is now absorbed into the new anchor. Caller is
          // responsible for clearing the live pinned_zone state (e.g.,
          // by clearing pin markers in assistant metadata) — runtime
          // contract: a successful Phase 2 implies pinned_zone reset.
          return makeEvent({
            eventId,
            sessionID,
            phase: 2,
            internalMode: "single-pass",
            inputTokens: inputTokenEstimate(phase2Request),
            outputTokens: Math.ceil(phase2.anchorBody.length / 4),
            pinnedCountIn: opts.pinnedZone.length,
            pinnedCountOut: 0, // absorbed
            droppedCountIn: opts.dropMarkers?.length,
            recallCountIn: 0,
            voluntary: opts.voluntary,
            latencyMs: Date.now() - startedAt,
            result: "success",
          })
        }
        // Phase 2 also failed → starvation (2.11, INV-6). Bounded chain
        // length = 2; no Phase 3 by design. Surface to runloop as
        // E_OVERFLOW_UNRECOVERABLE so the user gets a remediation
        // message instead of silent degradation.
        log.error("hybrid-llm Phase 2 starvation — E_OVERFLOW_UNRECOVERABLE", {
          sessionID,
          phase1Reason: first.reason,
          phase2Reason: phase2.reason,
          phase2Detail: phase2.detail,
        })
        return makeEvent({
          eventId,
          sessionID,
          phase: 2,
          internalMode: "single-pass",
          inputTokens: inputTokenEstimate(phase2Request),
          outputTokens: 0,
          pinnedCountIn: opts.pinnedZone.length,
          pinnedCountOut: opts.pinnedZone.length, // not absorbed
          droppedCountIn: opts.dropMarkers?.length,
          recallCountIn: 0,
          voluntary: opts.voluntary,
          latencyMs: Date.now() - startedAt,
          result: "unrecoverable",
          errorCode: "E_OVERFLOW_UNRECOVERABLE",
        })
      }

      // Graceful degradation. TODO Phase 2.9 follow-up: fallback provider.
      // For now we report failed_then_fallback with no anchor written;
      // runloop continues with the prior anchor in place.
      log.warn("hybrid-llm compaction failed after retries; falling back to prior anchor", {
        sessionID,
        reason: first.reason,
        detail: first.detail,
      })
      return makeEvent({
        eventId,
        sessionID,
        phase: 1,
        internalMode: "single-pass",
        inputTokens: inputTokenEstimate(request),
        outputTokens: 0,
        pinnedCountIn: opts.pinnedZone?.length,
        droppedCountIn: opts.dropMarkers?.length,
        recallCountIn: 0,
        voluntary: opts.voluntary,
        latencyMs: Date.now() - startedAt,
        result: "failed_then_fallback",
        errorCode: classifyErrorCode(first.reason),
      })
    }

    function classifyErrorCode(
      reason: LlmCompactResult & { ok: false } extends { reason: infer R } ? R : never,
    ): ErrorCode {
      if (reason === "timeout") return "E_HYBRID_LLM_TIMEOUT"
      if (reason === "llm_threw" || reason === "no_response") return "E_HYBRID_LLM_FAILED"
      // header_missing / size_overflow / sanity_smaller / forbidden_token / drop_violated
      return "E_HYBRID_LLM_MALFORMED"
    }

    // ─── Pinned envelope materialisation (Phase 2.14, DD-4 closes G-1) ──
    //
    // Pure function: wraps a pinned tool_result as a synthesised
    // user-role message envelope. The original tool_call/tool_result
    // pair stays untouched in journal (INV-4). The wrapped copy lives
    // in pinned_zone and survives Phase 1 compaction verbatim.
    //
    // Invoked by prompt.ts pre-prompt-build when the flag is on and
    // ContextMarkers.pin set is non-empty. The `pinnedToolCallIds`
    // input source is populated by Phase 5 (Layer 5 override surface).
    // Until Phase 5 wires the producer, this function lays dormant —
    // empty input → empty output → identical prompt assembly as today.

    /**
     * Wrap one pinned tool message into a user-role envelope per DD-4.
     * Pure function; no I/O.
     */
    export function wrapPinnedToolMessage(
      toolPart: MessageV2.ToolPart,
      sourceMessage: MessageV2.WithParts,
      opts: { pinnedAt?: string; pinnedBy?: "ai" | "human" } = {},
    ): PinnedZoneEntry {
      const toolName = (toolPart as any).tool ?? "unknown"
      const toolCallId = toolPart.callID
      // Best-effort round index from the source message — fallback 0.
      const roundIndex = (sourceMessage.info?.time?.created ?? 0) || 0
      // Stringify the tool's verbatim result. We accept either the
      // executed result (state.output) or the input args as fallback.
      const verbatim =
        ((toolPart as any).state?.output as string | undefined) ??
        (() => {
          try {
            return JSON.stringify((toolPart as any).state?.input ?? {})
          } catch {
            return ""
          }
        })()
      const content =
        `[Pinned earlier output] tool '${toolName}' (round ${roundIndex}, tool_call_id=${toolCallId}) returned:\n` +
        verbatim
      return {
        role: "user",
        content,
        metadata: {
          pinSource: { toolCallId, toolName, roundIndex },
          tokens: Math.ceil(content.length / 4),
          pinnedAt: opts.pinnedAt ?? new Date().toISOString(),
          pinnedBy: opts.pinnedBy ?? "ai",
        },
      }
    }

    /**
     * Materialise pinned_zone from a list of (sourceMessage, toolPart)
     * pairs as returned by Memory.Hybrid.getPinnedToolMessages(). Used
     * by prompt.ts pre-prompt-build (when flag on) to assemble the
     * pinned_zone slot of the 5-zone canonical prompt. Pure function.
     */
    export function materialisePinnedZone(
      sources: { message: MessageV2.WithParts; toolPart: MessageV2.ToolPart }[],
      opts: { pinnedBy?: "ai" | "human" } = {},
    ): PinnedZoneEntry[] {
      return sources.map((src) => wrapPinnedToolMessage(src.toolPart, src.message, { pinnedBy: opts.pinnedBy }))
    }

    function makeEvent(input: {
      eventId: string
      sessionID: string
      phase: Phase
      internalMode: InternalMode
      inputTokens: number
      outputTokens: number
      pinnedCountIn?: number
      pinnedCountOut?: number
      droppedCountIn?: number
      recallCountIn?: number
      voluntary?: boolean
      latencyMs: number
      result: CompactionEvent["result"]
      errorCode?: ErrorCode
    }): CompactionEvent {
      return {
        eventId: input.eventId,
        sessionId: input.sessionID,
        kind: "hybrid_llm",
        phase: input.phase,
        internalMode: input.internalMode,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        pinnedCountIn: input.pinnedCountIn,
        pinnedCountOut: input.pinnedCountOut,
        droppedCountIn: input.droppedCountIn,
        recallCountIn: input.recallCountIn,
        voluntary: input.voluntary,
        latencyMs: input.latencyMs,
        result: input.result,
        errorCode: input.errorCode,
        emittedAt: new Date().toISOString(),
      }
    }
  }
}
