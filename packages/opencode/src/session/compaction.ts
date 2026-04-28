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
import { ContinuationInvalidatedEvent } from "../plugin/codex-auth"

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
        mode: z.enum(["plugin", "llm"]),
      }),
    ),
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
    const usable =
      typeof overflowThreshold === "number"
        ? Math.floor(context * overflowThreshold)
        : reservedBasedUsable

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

    // 1. Write transcript summary as a text part
    await Session.updatePart({
      id: Identifier.ascending("part"),
      messageID: summaryMsg.id,
      sessionID: input.sessionID,
      type: "text",
      text: input.snapshot,
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

    Bus.publish(Event.Compacted, { sessionID: input.sessionID })

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
      await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID: continueMsg.id,
        sessionID: input.sessionID,
        type: "text",
        synthetic: true,
        text: "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.",
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
    | "manual"
    | "idle"

  export type KindName = "narrative" | "replay-tail" | "low-cost-server" | "llm-agent"

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
   * burn quota on them. `provider-switched` stops at kind 2 because raw
   * tail (2 in new chain) carries provider-specific tool format, so
   * `provider-switched` stops at narrative.
   *
   * Phase 13 (REVISED 2026-04-28): `schema` kind removed. Its sole role was
   * scavenging text from legacy SharedContext when narrative was empty —
   * but a fresh session should be empty, not back-filled from regex extracts.
   * Narrative empty → chain falls through to next kind naturally.
   */
  const KIND_CHAIN: Readonly<Record<Observed, ReadonlyArray<KindName>>> = Object.freeze({
    "overflow": Object.freeze(["narrative", "replay-tail", "low-cost-server", "llm-agent"] as const),
    "cache-aware": Object.freeze(["narrative", "replay-tail", "low-cost-server", "llm-agent"] as const),
    "idle": Object.freeze(["narrative", "replay-tail"] as const),
    "rebind": Object.freeze(["narrative", "replay-tail"] as const),
    "continuation-invalidated": Object.freeze(["narrative", "replay-tail"] as const),
    "provider-switched": Object.freeze(["narrative"] as const),
    "manual": Object.freeze(["narrative", "low-cost-server", "llm-agent"] as const),
  })

  /**
   * Whether a synthetic "Continue if you have next steps..." user message
   * is appended after the anchor. Only system-driven token-pressure triggers
   * permit it. Per R-6, rebind / continuation-invalidated / provider-switched
   * never inject Continue — that gate's the 2026-04-27 infinite loop bug
   * structurally extinct.
   */
  const INJECT_CONTINUE: Readonly<Record<Observed, boolean>> = Object.freeze({
    "overflow": true,
    "cache-aware": true,
    "idle": true,
    "rebind": false,
    "continuation-invalidated": false,
    "provider-switched": false,
    "manual": false,
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

    function findMostRecentAnchorMessage(
      messages: MessageV2.WithParts[],
    ): MessageV2.WithParts | undefined {
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
                typeof (p as any).input === "string"
                  ? (p as any).input
                  : JSON.stringify((p as any).input ?? {}),
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
    const accountId =
      agentModel?.accountId ?? input.userMessage.model.accountId ?? session?.execution?.accountId

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

    Bus.publish(Event.Compacted, { sessionID: input.sessionID })

    // Read summary text out for the caller (and the checkpoint save below).
    const summaryMsg = (await Session.messages({ sessionID: input.sessionID })).findLast(
      (m) => m.info.id === processor.message.id,
    )
    const summaryText = summaryMsg?.parts
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
      return "continue"
    }

    log.info("compaction.started", { sessionID, observed, step, intent })

    const baseChain = KIND_CHAIN[observed]
    // Manual --rich: skip 1-3 (free) and 4 (low-cost-server), go straight to llm-agent.
    const chain: ReadonlyArray<KindName> =
      observed === "manual" && intent === "rich" ? (["llm-agent"] as const) : baseChain

    const model = await resolveActiveModel(sessionID)
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
      content: string  // "[Pinned earlier output] tool '<name>' (round <K>, tool_call_id=<TID>) returned:\n<verbatim>"
      metadata: {
        pinSource: { toolCallId: string; toolName: string; roundIndex: number }
        tokens: number
        pinnedAt: string  // ISO-8601
        pinnedBy: "ai" | "human"
      }
    }

    /**
     * AI/human override markers carried in assistant message metadata
     * (`message.metadata.contextMarkers`). Parsed pre-prompt-build (DD-15).
     */
    export interface ContextMarkers {
      pin?: string[]   // tool_call ids → materialise into pinned_zone next prompt-build
      drop?: string[]  // tool_call ids → exclude from next compaction's LLM_compact input
      recall?: { sessionId?: string; msgId: string }[]  // re-load original disk content into journal tail
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
      priorAnchor: Anchor | null  // null = cold-start
      journalUnpinned: JournalEntry[]
      pinnedZone?: PinnedZoneEntry[]  // Phase 2 only
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
  }
}
