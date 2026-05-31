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
import { RuntimeEventService } from "../system/runtime-event-service"
import { SessionProcessor } from "./processor"
import { fn } from "@/util/fn"
import { Agent } from "@/agent/agent"
import { Plugin } from "@/plugin"
import { Config } from "@/config/config"
import { ProviderTransform } from "@/provider/transform"
import { SessionPrompt } from "./prompt"
import { SharedContext } from "./shared-context"
import { Memory } from "./memory"
import * as ToolIndex from "./tool-index"
import { Tweaks } from "../config/tweaks"
import { PostCompaction } from "./post-compaction"
import { ContinuationInvalidatedEvent } from "../plugin/codex-auth"
import {
  emitCompactionPredicateTelemetry,
  emitKindChainTelemetry,
  emitRecompressTelemetry,
  emitUserMsgReplayTelemetry,
} from "./compaction-telemetry"
import { sanitizeAnchorToString, type AnchorKind } from "./anchor-sanitizer"
import { shouldSkipClaudeEventCompaction } from "./claude-context-policy"
import { checkCleanTail } from "./idle-compaction-gate"
import { SkillLayerRegistry } from "./skill-layer-registry"
import { diagnoseCacheMiss } from "./cache-miss-diagnostic"
import { findUnansweredUserMessageId, parsePrevLastRound, serializeRedactedDialog } from "./dialog-serializer"

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

  /**
   * Resolve the current accountId for anchor writes. User messages may
   * not carry model.accountId (they are user-typed, not LLM-generated),
   * so we fall back to the session's execution state which is always
   * updated by the rotation system.
   */
  async function resolveAccountId(
    sessionID: string,
    userMessage?: { model?: { accountId?: string } } | null,
  ): Promise<string | undefined> {
    const fromMsg = userMessage?.model?.accountId
    if (fromMsg) return fromMsg
    const session = await Session.get(sessionID).catch(() => undefined)
    return session?.execution?.accountId
  }

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
  export async function publishCompactedAndResetChain(
    sessionID: string,
    eventMeta?: { observed?: string; kind?: string; tokensBefore?: number; tokensAfter?: number; success?: boolean },
  ) {
    Bus.publish(Event.Compacted, { sessionID })
    // 2026-05-20: reset cache baseline so the first post-rebind round
    // (which naturally has low cache — only the anchor prefix hits) is
    // not compared against the pre-compaction value. Without this, the
    // cliff detector fires a false continuation-invalidated → compaction
    // self-reinforcing loop. Incident ses_1c875cc15ffe5ds18JVdNAT4e6.
    SessionPrompt.resetCacheBaseline(sessionID)
    // 2026-05-09: append to per-session recentEvents ring for the Q card.
    // 2026-05-13: moved BEFORE Continuation.run so the ring entry lands
    // in the synchronous microtask path. publishCompactedAndResetChain is
    // called fire-and-forget (`void`) from multiple callers; with
    // Continuation.run first, the outer awaiter (or test) would resolve
    // before the ring entry was actually pushed. Order is correctness-
    // irrelevant — ring is read on the NEXT prompt build by
    // decideAmnesiaInjection, well after both sites resolve.
    void Session.appendRecentEvent(sessionID, {
      ts: Date.now(),
      kind: "compaction",
      compaction: {
        observed: eventMeta?.observed ?? "unknown",
        kind: eventMeta?.kind,
        success: eventMeta?.success !== false,
        tokensBefore: eventMeta?.tokensBefore,
        tokensAfter: eventMeta?.tokensAfter,
      },
    }).catch(() => {})
    // 2026-05-12 (Phase C of session/rebind-procedure-revision): chain
    // invalidation routes through Continuation.run so the post-compaction
    // outbound also picks up an amnesia_notice with commitment digest
    // (extends the L3 amnesia notice with mutation context — DD-2). Map
    // (observed, kind) onto the most specific ContinuationEvent kind
    // for the classifier; default is compaction_narrative.
    const continuationKind = mapCompactionEventMetaToKind(eventMeta)
    try {
      const { Continuation } = await import("./continuation/run")
      await Continuation.run({
        kind: continuationKind,
        sessionID,
        anchorId: eventMeta?.kind ?? "unknown",
        // providerId is best-effort here — at this site we don't have
        // direct access. Continuation.run resolves provider class with
        // the SL fallback when providerId is absent, which keeps the
        // call a no-op-on-chain-id for SL providers (the existing
        // semantics) while still emitting amnesia + telemetry events.
        providerId: "codex",
      })
    } catch (err) {
      Log.create({ service: "session.compaction" }).warn("Continuation.run threw at compaction publish", {
        sessionID,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /**
   * Map the existing (observed, kind) compaction telemetry pair onto the
   * ContinuationEvent.kind discriminator. Conservative: any unrecognised
   * combination falls back to `compaction_narrative`, which has the
   * strongest amnesia-notice semantics (the worst-case for the AI).
   *
   * Recognised observed values:
   *   - "cache-aware"  → compaction_cache_aware
   *   - "stall-recovery"  → compaction_stall_recovery
   *   - "preemptive-daemon-restart"  → compaction_preemptive_daemon_restart
   *   - "overflow" / "manual" / "auto" / "idle" / "continuation-invalidated"
   *     → compaction_narrative
   *
   * Recognised kind values:
   *   - "server-side" / "ai_free"  → compaction_server_side (chain
   *     preserved by codex; classifier returns breaksChain=false +
   *     skipReason="server_side_compaction")
   */
  function mapCompactionEventMetaToKind(eventMeta?: {
    observed?: string
    kind?: string
  }):
    | "compaction_narrative"
    | "compaction_cache_aware"
    | "compaction_stall_recovery"
    | "compaction_preemptive_daemon_restart"
    | "compaction_server_side" {
    if (
      eventMeta?.kind === "server-side" ||
      eventMeta?.kind === "ai_free" ||
      eventMeta?.kind === "low-cost-server"
    ) {
      return "compaction_server_side"
    }
    switch (eventMeta?.observed) {
      case "cache-aware":
        return "compaction_cache_aware"
      case "stall-recovery":
        return "compaction_stall_recovery"
      case "preemptive-daemon-restart":
        return "compaction_preemptive_daemon_restart"
      default:
        return "compaction_narrative"
    }
  }

  const COMPACTION_BUFFER = 20_000
  const DEFAULT_HEADROOM = 8_000
  const DEFAULT_COOLDOWN_ROUNDS = 8
  const EMERGENCY_CEILING = 2_000
  const SMALL_CONTEXT_MAX = 128_000
  const SMALL_CONTEXT_RESERVED_TOKENS = 5_000
  const CHARS_PER_TOKEN = 4

  // Billing-aware compaction: by-token providers pay per token (aggressive
  // compaction saves money). By-request providers (copilot etc) pay per
  // request — compaction costs nothing extra and is mandatory for small
  // context windows (128K) where anchor + tail easily overflow.
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

  /**
   * DD-10 / R11 — freerun sessions bypass all compaction triggers.
   * The engine manages context via per-iteration tree rendering + subtree
   * consolidation; opencode's message-history compaction would defeat the
   * stateless-iteration invariant.
   */
  async function isFreerunProvider(model: Provider.Model): Promise<boolean> {
    try {
      const cfg = await Config.get()
      const providerCfg = (cfg.provider as Record<string, { lite?: boolean; mode?: "full" | "lite" | "freerun" }> | undefined)?.[
        model.providerId
      ]
      return providerCfg?.mode === "freerun"
    } catch {
      return false
    }
  }

  export async function isOverflow(input: {
    tokens: MessageV2.Assistant["tokens"]
    model: Provider.Model
    sessionID?: string
    currentRound?: number
  }) {
    if (await isFreerunProvider(input.model)) return false
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
    if (await isFreerunProvider(input.model)) return false
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

    // DD-10: classify the cache miss before triggering. If the system block
    // bytes are churning across recent turns, compacting the conversation
    // will not help (cache will miss again next turn). Only fire when the
    // miss is plausibly attributable to conversation growth.
    if (input.sessionID) {
      const diag = diagnoseCacheMiss({
        sessionID: input.sessionID,
        conversationTailTokens: totalInput,
      })
      log.info("compaction.cache_miss_diagnosis", {
        sessionID: input.sessionID,
        kind: diag.kind,
        shouldCompact: diag.shouldCompact,
        lastSystemHashes: diag.lastSystemHashes.map((h) => h.slice(0, 8)),
        conversationTailTokens: diag.conversationTailTokens,
      })
      if (!diag.shouldCompact) {
        return false
      }
    }

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
    return k === "narrative"
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
   * `KIND_CHAIN["idle"] = ["narrative"]` covers the same
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

    // DD-7: defer if the conversation tail has any unmatched tool_use parts
    // (pending/running). Inserting an anchor mid-flight would split the
    // tool_use ↔ tool_result pair Anthropic strict-pairing requires.
    const tailMessages = await Session.messages({ sessionID: input.sessionID }).catch(() => [] as MessageV2.WithParts[])
    const cleanCheck = checkCleanTail(tailMessages, 2)
    if (!cleanCheck.clean) {
      log.info("compaction.idle.deferred", {
        sessionID: input.sessionID,
        reason: cleanCheck.reason ?? "unclean-tail",
        scannedMessageCount: cleanCheck.scannedMessageCount,
      })
      return
    }

    // Guard: if the newest message is a user message, a new prompt arrived
    // while the previous runloop is still in its post-loop cleanup phase
    // (idle compaction runs INSIDE the old runloop's `using _ = defer(finishRuntime)`
    // window, before the runtime slot is released). The user message was
    // already written to DB by createUserMessage, but the new runLoop hasn't
    // started yet (it's blocked on waitForRuntimeSlot).
    //
    // Writing a compaction anchor here would give it a newer ID than the user
    // message. filterCompacted scans newest-first and stops at the anchor,
    // hiding the user message entirely. The new runloop would then hit
    // no_user_after_compaction and exit silently — swallowing the user's
    // input with no response.
    //
    // tailMessages is chronological (oldest→newest), so .at(-1) is the most
    // recent message.
    const newest = tailMessages.at(-1)
    if (newest && newest.info.role === "user") {
      log.info("compaction.idle.deferred", {
        sessionID: input.sessionID,
        reason: "pending-user-message",
        newestMessageId: newest.info.id,
      })
      return
    }

    await run({
      sessionID: input.sessionID,
      observed: "idle",
      step: 0,
    })
  }

  /**
   * Writes a compaction anchor from a pre-computed body string. Creates a
   * synthetic summary assistant message from the provided snapshot,
   * bypassing the LLM compaction agent call. Used by both idle
   * compaction and overflow compaction paths.
   *
   * T9 (compaction_simplification): renamed from `compactWithSharedContext`.
   * The old name was misleading — after T6 nothing here writes to
   * SharedContext.Space. The legacy export name is retained as a
   * deprecated alias for one cycle (see bottom of namespace).
   */
  export async function writeAnchorFromBody(input: {
    sessionID: string
    snapshot: string
    model: Provider.Model
    auto: boolean
    /**
     * user-msg-replay-unification DD-5 / DD-10: thread the observed
     * condition through so publishCompactedAndResetChain can record it
     * in recentEvents instead of falling back to "unknown". Optional
     * for back-compat with legacy callers that didn't supply it; new
     * callers (defaultWriteAnchor, provider-switch pre-loop) MUST set
     * it. Defaults to "manual" when absent (closest legacy meaning for
     * direct API callers).
     */
    observed?: Observed
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

    // Ping-pong anchor: always create a fresh anchor so its ID sorts
    // correctly in the message stream, then retire the old one.  If the
    // new write fails, the old anchor is still intact — no data loss.
    // At most two anchors coexist briefly; the reader (getAnchorMessage)
    // picks the newest by ID.
    const prevAnchor = await Memory.Hybrid.getAnchorMessage(input.sessionID, msgs).catch(() => null)
    const followUps = await PostCompaction.gather(input.sessionID)
    const followUpAddendum = PostCompaction.buildSummaryAddendum(followUps)
    const fullBody = input.snapshot + followUpAddendum

    const accountId = await resolveAccountId(input.sessionID, userMessage)

    // Step 1: create new anchor
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
      accountId,
      time: { created: Date.now() },
    })) as MessageV2.Assistant

    await Session.updatePart({
      id: Identifier.ascending("part"),
      messageID: summaryMsg.id,
      sessionID: input.sessionID,
      type: "text",
      text: fullBody,
      time: { start: Date.now(), end: Date.now() },
    })

    await Session.updatePart({
      id: Identifier.ascending("part"),
      messageID: summaryMsg.id,
      sessionID: input.sessionID,
      type: "compaction",
      auto: input.auto,
    })

    // Step 2: retire old anchor now that the new one is safely written
    if (prevAnchor) {
      await Session.removeMessage({ sessionID: input.sessionID, messageID: prevAnchor.info.id }).catch(() => undefined)
    }

    log.info("shared context compaction complete", { sessionID: input.sessionID })

    // Phase 13.2-B: disk-file checkpoint write removed. The anchor message
    // written above IS the durable record; rebind reads it via stream scan.

    void publishCompactedAndResetChain(input.sessionID, {
      observed: input.observed ?? "manual",
      kind: "narrative",
    })

    // Schedule background enrichment (merge N→1 if anchor floor > 20%).
    // Previously only run() called this; create() (used by /compact) skipped it.
    scheduleHybridEnrichment(input.sessionID, input.observed ?? "manual", input.model)

    if (input.auto) {
      const continueText = PostCompaction.buildContinueText(followUps)
      if (!continueText) return

      // Create continue message for auto mode only when a non-empty directive
      // is intentionally produced.
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
        text: continueText,
        time: {
          start: Date.now(),
          end: Date.now(),
        },
      })
    }
  }

  /**
   * @deprecated T9 alias — use `writeAnchorFromBody`. Retained for one
   * cycle so external callers in prompt.ts and tests keep compiling.
   * Removed in a future cleanup once all call sites are migrated.
   */
  export const compactWithSharedContext = writeAnchorFromBody

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
    | "reload"

  export type KindName = "narrative" | "ai_free" | "ai_paid"
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
  // Foreground chain: narrative only. All AI-based compaction (ai_free,
  // ai_paid) is handled by background enrichment via scheduleHybridEnrichment.
  // Foreground must never block the user waiting for API calls.
  const KIND_CHAIN: Readonly<Record<Observed, ReadonlyArray<KindName>>> = Object.freeze({
    overflow: Object.freeze(["narrative", "ai_paid"] as const),
    "cache-aware": Object.freeze(["narrative", "ai_paid"] as const),
    idle: Object.freeze(["narrative"] as const),
    rebind: Object.freeze(["narrative"] as const),
    "continuation-invalidated": Object.freeze(["narrative"] as const),
    "provider-switched": Object.freeze(["narrative"] as const),
    "stall-recovery": Object.freeze(["narrative"] as const),
    manual: Object.freeze(["narrative"] as const),
    "empty-response": Object.freeze(["narrative"] as const),
    reload: Object.freeze(["narrative"] as const),
  })

  export function kindChainFor(observed: Observed): ReadonlyArray<KindName> {
    return KIND_CHAIN[observed]
  }

  /**
   * Resolve the per-event compaction kind chain for the active provider.
   *
   * 2026-05-08 simplification (per user direction):
   *   - codex provider → server-side `/responses/compact` is always
   *     attempted FIRST. Prepend `low-cost-server` to the base chain
   *     (or move it to head if already present), preserving the rest
   *     of the fallback order.
   *   - any other provider → local-first (the base KIND_CHAIN order,
   *     which already starts with `narrative` / `replay-tail` for
   *     every observed condition).
   *
   * The earlier `codexServerPriorityRatio` ctxRatio gate is removed:
   * codex subscription doesn't bill server-side compaction, so there
   * is no cost reason to defer it. The `ctxRatio` /
   * `codexServerPriorityRatio` / `isSubscription` parameters are
   * retained as optional for back-compat with existing call sites
   * but are no longer consulted.
   */
  export function resolveKindChain(input: {
    observed: Observed
    providerId?: string
    isSubscription?: boolean
    ctxRatio?: number
    codexServerPriorityRatio?: number
    byRequest?: boolean
  }): ReadonlyArray<KindName> {
    const base = KIND_CHAIN[input.observed]
    // By-request providers (copilot, etc): compaction costs nothing extra
    // (charged per request, not per token). Small context windows (128K)
    // make aggressive compaction mandatory — without it, anchor + tail
    // overflow and session is paralyzed. Append ai_paid to the chain
    // so narrative failure or overflow escalates to LLM summarization.
    if (input.byRequest && (input.observed === "overflow" || input.observed === "cache-aware")) {
      return Object.freeze([...base, "ai_paid"] as const)
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
    // 2026-05-19: changed to true. Cache cliff (silent server eviction)
    // triggers continuation-invalidated. Without synthetic Continue,
    // the runloop exits after compaction because the user message was
    // folded into the anchor and no user message remains post-anchor.
    "continuation-invalidated": true,
    "provider-switched": false,
    "stall-recovery": false,
    manual: false,
    // empty-response auto-heal: token pressure drove the burp, so a synthetic
    // "Continue from where you left off" after the anchor lets the model
    // resume the user's actual request without a fresh user prompt.
    "empty-response": true,
    reload: false,
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
    | {
        ok: true
        summaryText: string
        kind: KindName
        anchorWritten?: boolean
        truncated?: boolean
        /**
         * compaction-fix Phase 2 (DD-8): server-compacted ResponseItem[]
         * to persist on the anchor's compaction part metadata. Only set
         * by `tryLowCostServer` when the codex `/responses/compact` plugin
         * returned non-empty `compactedItems`. Forwarded into
         * `WriteAnchorInput` so `defaultWriteAnchor` writes them and the
         * accompanying `chainBinding` into `metadata.serverCompactedItems`
         * and `metadata.chainBinding`.
         */
        serverCompactedItems?: unknown[]
        chainBinding?: { accountId: string; modelId: string; capturedAt: number }
      }

  /**
   * Spec compaction/dialog-replay-redaction (DD-3). Builds the local
   * (zero-API-cost) anchor body from the formal model:
   *   anchor[n+1].body = anchor[n].body + serialize_redacted(tail)
   * where the serialised tail excludes the unanswered user message
   * (Spec 1 synergy — replayed post-anchor by replayUnansweredUserMessage).
   *
   * compaction_simplification T2a (2026-05-14): renamed from
   * `tryNarrativeRedactedDialog`; the `enableDialogRedactionAnchor=false`
   * legacy `Memory.renderForLLMSync` fallback (`tryNarrativeLegacy`) is
   * retired because production has used the redacted-dialog path
   * exclusively since the flag's default flipped to true. The
   * `transformPostAnchorTail` v6 fallback still honours the flag.
   */
  async function tryLocalRedactedDialog(input: RunInput, _model: Provider.Model | undefined): Promise<KindAttempt> {
    const messages = await Session.messages({ sessionID: input.sessionID }).catch(() => [] as MessageV2.WithParts[])
    if (messages.length === 0) return { ok: false, reason: "memory empty" }

    const prevAnchor = await Memory.Hybrid.getAnchorMessage(input.sessionID, messages)
    const prevAnchorIdx = prevAnchor ? messages.findIndex((m) => m.info.id === prevAnchor.info.id) : -1
    const prevBody = prevAnchor ? extractAnchorTextBody(prevAnchor) : ""

    // Anchor bloat guard: if the existing anchor already consumes ≥50%
    // of the context window, narrative concatenation will only make it
    // bigger.  Bail out so the kind chain escalates to ai_paid which
    // can actually re-summarize and shrink the anchor.
    if (prevBody && _model) {
      const anchorTokenEstimate = Math.ceil(prevBody.length / 4)
      const contextLimit = _model.limit.context
      if (contextLimit > 0 && anchorTokenEstimate >= contextLimit * 0.5) {
        log.info("narrative.anchor_bloat_escalation", {
          sessionID: input.sessionID,
          anchorTokenEstimate,
          contextLimit,
          ratio: Math.round((anchorTokenEstimate / contextLimit) * 100),
        })
        return { ok: false, reason: "anchor exceeds 50% of context — escalating to ai_paid" }
      }
    }

    const prevLastRound = parsePrevLastRound(prevBody)

    const unansweredId = findUnansweredUserMessageId(messages, prevAnchorIdx === -1 ? undefined : prevAnchorIdx)
    const tail = messages.slice(prevAnchorIdx + 1)

    const { text: tailText, messagesEmitted } = serializeRedactedDialog(tail, {
      startRound: prevLastRound + 1,
      excludeUserMessageID: unansweredId,
    })

    if (messagesEmitted === 0 && prevBody === "") {
      return { ok: false, reason: "memory empty" }
    }

    const body = prevBody && tailText ? `${prevBody}\n\n${tailText}` : prevBody || tailText

    return { ok: true, summaryText: body, kind: "narrative", truncated: false }
  }

  /**
   * Demote any summary=true anchors that have no text body (stub anchors
   * left behind by failed ai_paid runs). Without this, filterCompacted
   * slices from a bodyless anchor → context drops to near zero.
   */
  async function demoteStubAnchors(sessionID: string, msgs?: MessageV2.WithParts[]) {
    const messages = msgs ?? await Session.messages({ sessionID }).catch(() => [] as MessageV2.WithParts[])
    for (const m of messages) {
      if (m.info.role !== "assistant") continue
      if ((m.info as MessageV2.Assistant).summary !== true) continue
      const hasTextBody = m.parts.some((p) => p.type === "text" && (p as any).text?.trim())
      if (!hasTextBody) {
        await Session.updateMessage({ ...(m.info as any), summary: false }).catch(() => undefined)
        log.warn("demoted stub anchor (no text body)", { sessionID, anchorId: m.info.id })
      }
    }
  }

  function extractAnchorTextBody(anchor: MessageV2.WithParts): string {
    const fragments: string[] = []
    for (const p of anchor.parts) {
      if (p.type === "text" && typeof (p as MessageV2.TextPart).text === "string") {
        fragments.push((p as MessageV2.TextPart).text)
      }
    }
    return fragments.join("\n").trim()
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

    const accountId = await resolveAccountId(input.sessionID, userMessage)

    let hookResult: { compactedItems: unknown[] | null; summary: string | null }
    try {
      hookResult = (await Plugin.trigger(
        "session.compact",
        {
          sessionID: input.sessionID,
          model: {
            providerId: model.providerId,
            modelID: model.id,
            accountId,
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
    // compaction-fix Phase 2 (DD-8/DD-9): forward the structured items
    // along with chain identity (account/model snapshot at compact time)
    // so the anchor writer persists them as metadata for future
    // anchor-prefix expansion. summaryText remains the textual fallback
    // when chainBinding fails to validate at projection time (DD-9).
    return {
      ok: true,
      summaryText,
      kind: "ai_free",
      serverCompactedItems: hookResult.compactedItems,
      chainBinding: {
        accountId: accountId ?? "",
        modelId: model.id,
        capturedAt: Date.now(),
      },
    }
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
      // Skip compaction anchor messages (summary=true). These are our
      // own compaction output — sending them back to /responses/compact
      // inflates the payload massively (55 anchors × 150K chars each)
      // and the server cannot process them.
      if (msg.info.role === "assistant" && (msg.info as MessageV2.Assistant).summary === true) continue
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
            const outputStr =
              stateOutput == null ? "" :
              typeof stateOutput === "string" ? stateOutput :
              JSON.stringify(stateOutput)
            items.push({
              type: "function_call_output",
              call_id: (p as any).toolCallId ?? p.id,
              output: outputStr,
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
        observed: input.observed,
      })
      if (!summaryText) {
        // LLM agent wrote a stub anchor (summary=true) but produced no text.
        // Demote it so filterCompacted doesn't slice from a bodyless anchor.
        await demoteStubAnchors(input.sessionID, messages)
        return { ok: false, reason: "llm-agent produced empty summary" }
      }
      return { ok: true, summaryText, kind: "ai_paid", anchorWritten: true }
    } catch (err) {
      // LLM agent may have written a stub anchor before throwing.
      await demoteStubAnchors(input.sessionID).catch(() => {})
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
    /**
     * user-msg-replay-unification DD-5 / DD-10: observed value threaded
     * through so the inner publishCompactedAndResetChain call records
     * it in recentEvents instead of "unknown". Was previously a missing
     * field that produced a TS2339 error at the publish call site.
     */
    observed: Observed
  }): Promise<string | null> {
    Bus.publish(Event.CompactionStarted, { sessionID: input.sessionID, mode: "llm" })

    const agent = await Agent.get("compaction")
    log.info("triggering TRUE Summary Compaction (LLM agent)", { sessionID: input.sessionID })
    const model = agent.model
      ? await Provider.getModel(agent.model.providerId, agent.model.modelID)
      : input.userMessage.model
        ? await Provider.getModel(input.userMessage.model.providerId, input.userMessage.model.modelID)
        : await Provider.getModel(...(await Provider.defaultModel().then((m) => [m.providerId, m.modelID] as const)))

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
    const accountId = agentModel?.accountId ?? input.userMessage.model?.accountId ?? session?.execution?.accountId

    // T7 lineage
    const prevAnchorId = (await Memory.Hybrid.getAnchorMessage(input.sessionID).catch(() => null))?.info.id

    // AI-generated anchor = zero anchor: demote all existing anchors
    // so this LLM summary starts fresh (same logic as defaultWriteAnchor).
    for (const m of input.messages) {
      if (m.info.role !== "assistant") continue
      if ((m.info as MessageV2.Assistant).summary !== true) continue
      await Session.updateMessage({ ...(m.info as any), summary: false }).catch(() => undefined)
    }

    const msg = (await Session.updateMessage({
      id: Identifier.ascending("message"),
      role: "assistant",
      parentID: input.parentID,
      sessionID: input.sessionID,
      mode: "compaction",
      agent: "compaction",
      variant: input.userMessage.variant,
      summary: true,
      replacesAnchorId: prevAnchorId,
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

    // DD-6: rewrite the LLM-streamed text parts in place with sanitized
    // bodies before the compaction boundary marker is written. The
    // streamed parts are already persisted, so we issue Session.updatePart
    // for each one to replace the on-disk text. The same sanitizer runs in
    // defaultWriteAnchor for the non-LLM kinds (narrative / replay-tail /
    // low-cost-server) — this branch handles the kind 5 path where the
    // persisted message is the anchor itself.
    const preSanitizedMsg = (await Session.messages({ sessionID: input.sessionID })).findLast(
      (m) => m.info.id === processor.message.id,
    )
    const preSanitizedTextParts = preSanitizedMsg?.parts.filter((p) => p.type === "text") ?? []
    let imperativePrefixApplied = false
    let originalLength = 0
    let sanitizedLength = 0
    for (const part of preSanitizedTextParts) {
      const original = (part as any).text ?? ""
      originalLength += original.length
      const sanitized = sanitizeAnchorToString(original, "ai_paid")
      if (sanitized.imperativePrefixApplied) imperativePrefixApplied = true
      sanitizedLength += sanitized.body.length
      await Session.updatePart({
        id: part.id,
        messageID: processor.message.id,
        sessionID: input.sessionID,
        type: "text",
        text: sanitized.body,
        time: (part as any).time ?? { start: Date.now(), end: Date.now() },
      })
    }
    log.info("compaction.anchor.sanitized", {
      sessionID: input.sessionID,
      kind: "ai_paid",
      originalLength,
      sanitizedLength,
      imperativePrefixApplied,
      partCount: preSanitizedTextParts.length,
    })

    // DD-9: skill auto-pin + snapshot for the LLM-agent path. The previous
    // anchor (if any) is the most-recent summary-true message OTHER than
    // processor.message; readMostRecentAnchorId returns the just-written
    // one, so we filter it out.
    const allAnchorMsgs = (await Session.messages({ sessionID: input.sessionID })).filter(
      (m) => m.info.role === "assistant" && (m.info as MessageV2.Assistant).summary === true,
    )
    const prevLlmAnchorId = allAnchorMsgs.filter((m) => m.info.id !== processor.message.id).at(-1)?.info.id

    const sanitizedJoined = preSanitizedTextParts.map((p) => (p as any).text ?? "").join("\n")
    await annotateAnchorWithSkillState({
      sessionID: input.sessionID,
      summaryText: sanitizedJoined,
      prevAnchorId: prevLlmAnchorId,
      kind: "ai_paid",
      explicitAnchorId: processor.message.id,
    })

    // Write the compaction boundary anchor on the summary assistant message.
    await Session.updatePart({
      id: Identifier.ascending("part"),
      messageID: processor.message.id,
      sessionID: input.sessionID,
      type: "compaction",
      auto: input.auto,
    })

    void publishCompactedAndResetChain(input.sessionID, {
      observed: input.observed,
      kind: "ai_paid",
    })

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
        return tryLocalRedactedDialog(input, model)
      case "ai_free":
        return tryLowCostServer(input, model)
      case "ai_paid":
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
  const hybridEnrichInFlight = new Map<string, { promise: Promise<unknown>; startedAt: number }>()
  /** Max time an enrichment can stay in-flight before being considered stale (5 min). */
  const ENRICHMENT_IN_FLIGHT_TIMEOUT_MS = 5 * 60 * 1000

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
    // 2026-05-13 rev2: add RuntimeEventService telemetry so the
    // background enrichment lifecycle is observable in the runtime
    // event journal (previously only Log.info, invisible to dashboards
    // and post-hoc audit per session/rebind-procedure-revision DD-14).
    const emitTelemetry = (eventType: string, extra: Record<string, unknown> = {}) => {
      void RuntimeEventService.append({
        sessionID,
        level: "info",
        domain: "telemetry",
        eventType,
        anomalyFlags: [],
        payload: { observed, providerId: model?.providerId ?? null, ...extra },
      }).catch(() => undefined)
    }
    if (!model) {
      console.error(`[ENRICH-SKIP] reason=no_model session=${sessionID}`)
      emitTelemetry("session.hybrid_enrichment.skipped", { reason: "no_model" })
      return
    }
    const tweaks = Tweaks.compactionSync()
    if (!tweaks.enableHybridLlm) {
      console.error(`[ENRICH-SKIP] reason=flag_disabled session=${sessionID}`)
      emitTelemetry("session.hybrid_enrichment.skipped", { reason: "flag_disabled" })
      return
    }
    const existing = hybridEnrichInFlight.get(sessionID)
    if (existing && Date.now() - existing.startedAt < ENRICHMENT_IN_FLIGHT_TIMEOUT_MS) {
      console.error(`[ENRICH-SKIP] reason=in_flight session=${sessionID} age=${Date.now() - existing.startedAt}ms`)
      emitTelemetry("session.hybrid_enrichment.skipped", { reason: "in_flight" })
      return
    }
    if (existing) {
      // Stale entry — previous enrichment hung or leaked. Clear it.
      log.warn("hybrid_llm enrichment: cleared stale in-flight entry", {
        sessionID,
        staleSinceMs: Date.now() - existing.startedAt,
      })
      hybridEnrichInFlight.delete(sessionID)
    }

    emitTelemetry("session.hybrid_enrichment.scheduled")

    // Surface enrichment lifecycle in recentEvents so the sidebar Q card
    // shows background recompress status (started → success/failure).
    const emitEnrichmentStatus = (status: "started" | "success" | "failed", detail?: string) => {
      // "started" is noise in the sidebar — only emit success/failed
      if (status === "started") return
      void Session.appendRecentEvent(sessionID, {
        ts: Date.now(),
        kind: "compaction",
        compaction: {
          observed: `enrichment:${status}`,
          kind: "enrichment",
          success: status === "success",
        },
      }).catch(() => undefined)
    }

    // dialog-replay-redaction DD-4: when the redaction master flag is on,
    // recompress fires on size (50K ceiling) regardless of `observed`. When
    // off, retain the legacy observed-gate {overflow, cache-aware, manual}.
    const dialogRedactionFlag =
      (tweaks as { enableDialogRedactionAnchor?: boolean }).enableDialogRedactionAnchor !== false
    if (!dialogRedactionFlag && !new Set<Observed>(["overflow", "cache-aware", "manual"]).has(observed)) {
      console.error(`[ENRICH-SKIP] reason=observed_not_eligible observed=${observed} dialogRedactionFlag=${dialogRedactionFlag} session=${sessionID}`)
      return
    }

    console.error(`[ENRICH-GO] session=${sessionID} observed=${observed} provider=${model.providerId}`)
    const promise = (async () => {
      try {
        emitEnrichmentStatus("started")
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
        const ceilingTokens =
          (tweaks as { anchorRecompressCeilingTokens?: number }).anchorRecompressCeilingTokens ?? 50_000
        const contextLimit = model.limit?.context ?? 0

        // Gate: skip enrichment if anchor body is small relative to context.
        // Rebind triggers on every rotation regardless of context pressure —
        // no point polishing a 5% anchor.
        // Dynamic threshold: small context (≤128K) → 25% (every token counts),
        // large context (>128K) → 40% (more room to spare).
        const enrichGateRatio = contextLimit <= 128_000 ? 0.25 : 0.40
        const anchorRatio = contextLimit > 0 ? narrativeTokens / contextLimit : 0
        if (anchorRatio < enrichGateRatio) {
          log.info("hybrid_llm enrichment skipped (anchor body < 50% of context)", {
            sessionID,
            narrativeTokens,
            contextLimit,
            anchorRatio,
          })
          console.error(`[ENRICH-SKIP] reason=anchor_small ratio=${(anchorRatio * 100).toFixed(0)}% tokens=${narrativeTokens} ctx=${contextLimit} session=${sessionID}`)
          return
        }

        // Collect all anchors. Because narrative compaction uses chained
        // concat (anchor N = anchor N-1 body + new dialog), the LATEST
        // anchor already contains all predecessor content. Feeding all
        // bodies to the compressor would repeat content N times. Instead,
        // compress only the latest anchor body and demote all older ones.
        const allAnchorMsgs: MessageV2.WithParts[] = []
        for (const m of messagesPre) {
          if (m.info.role !== "assistant") continue
          if ((m.info as MessageV2.Assistant).summary !== true) continue
          allAnchorMsgs.push(m)
        }
        // Latest anchor body = the superset (chained concat).
        const latestBody = narrativeContent
        const latestTokens = narrativeTokens
        log.info("hybrid_llm enrichment: compressing latest anchor + demoting old", {
          sessionID,
          anchorCount: allAnchorMsgs.length,
          latestAnchorTokens: latestTokens,
        })

        // Anchors to demote after successful recompress (all except the latest).
        const anchorsTodemote = allAnchorMsgs.slice(0, -1)

        const trigger: "size-ceiling" | "legacy-large-policy" =
          dialogRedactionFlag && latestTokens >= ceilingTokens ? "size-ceiling" : "legacy-large-policy"
        // Provider dispatch: codex sessions go to /responses/compact via the
        // existing low-cost-server plugin path. If that fails, enrichment
        // stops — no paid LLM fallback for background quality upgrades.
        // Shared success callback for codex path + drop-old-history path.
        const demoteOldAnchors = async () => {
          for (const old of anchorsTodemote) {
            await Session.updateMessage({
              ...(old.info as any),
              summary: false,
            }).catch(() => undefined)
          }
          if (anchorsTodemote.length > 0) {
            log.info("hybrid_llm enrichment: demoted old anchors after merge", {
              sessionID,
              demoted: anchorsTodemote.length,
            })
          }
        }

        // -- Enrichment priority chain ---------------------------------
        // 1. drop old history -- trim anchor body (free, instant)
        // 2. ai_paid  -- LLM summarisation (last resort)
        //
        // ai_free disabled: encrypted blob anchor incompatible with
        // rotation-heavy sessions (chain binding invalidated on switch).
        // Chain stops at the first success.

        const recompressStartedAt = Date.now()
        const baseTelemetry = {
          sessionID,
          trigger,
          kind: "hybrid_llm" as const,
          providerId: model.providerId,
          anchorTokensBefore: narrativeTokens,
        }

        // ai_free (codex /responses/compact) disabled — encrypted blob
        // anchor is incompatible with rotation-heavy sessions (chain
        // binding invalidated on every account switch). Enrichment chain
        // is now: drop_old_history → ai_paid.

        // ── Step 1: drop old history from anchor body ──
        // Chained concat means the latest anchor body contains all
        // predecessor content. "Drop old" = truncate the body to keep
        // only the most recent generation (the tail text that was
        // appended in the last narrative compaction). Also demote all
        // predecessor anchor messages.
        {
          emitTelemetry("session.hybrid_enrichment.drop_old_history")
          // Keep 40% of the anchor's own body length (not 40% of context).
          // If anchor is 40% of context, keeping 40% of it = 16% of context.
          // This ensures meaningful compression regardless of anchor size.
          const KEEP_RATIO = 0.40
          const keepChars = Math.floor(latestBody.length * KEEP_RATIO)
          let trimmedBody = latestBody
          if (latestBody.length > keepChars) {
            trimmedBody = latestBody.slice(-keepChars)
            // Clean cut at a round boundary
            const roundBoundary = trimmedBody.indexOf("\n## Round ")
            if (roundBoundary > 0 && roundBoundary < trimmedBody.length * 0.3) {
              trimmedBody = trimmedBody.slice(roundBoundary + 1)
            }
          }
          const anchorTextPart = narrativeAnchorMsg.parts.find((p) => p.type === "text")
          const trimmedTokens = Math.ceil(trimmedBody.length / 4)
          const trimmedRatio = contextLimit > 0 ? trimmedTokens / contextLimit : 0
          // Only count drop_old as success if it actually compressed
          // enough (< 35% of context). Otherwise fall through to ai_paid.
          // reload-generated anchors have no Round boundaries to cut at,
          // so drop_old barely shaves anything — must not block ai_paid.
          if (anchorTextPart && trimmedBody.length < latestBody.length && trimmedRatio < 0.35) {
            await Session.updatePart({ ...(anchorTextPart as any), text: trimmedBody })
            await demoteOldAnchors()
            log.info("enrichment step 2: dropped old history from anchor body", {
              sessionID,
              originalTokens: narrativeTokens,
              keptTokens: trimmedTokens,
              trimmedRatio,
              demoted: anchorsTodemote.length,
            })
            emitEnrichmentStatus("success")
            emitRecompressTelemetry({
              ...baseTelemetry,
              result: "success",
              errorMessage: "drop_old_history",
              anchorTokensAfter: trimmedTokens,
              latencyMs: Date.now() - recompressStartedAt,
            })
            return
          }
          if (anchorTextPart && trimmedBody.length < latestBody.length) {
            log.info("enrichment: drop_old_history insufficient, falling through to ai_paid", {
              sessionID,
              trimmedTokens,
              trimmedRatio: Math.round(trimmedRatio * 100),
              contextLimit,
            })
          }
        }

        // ── Step 2: ai_paid (LLM) — last resort when drop_old didn't apply ──
        log.info("enrichment step 2 (ai_paid LLM): anchor not trimmed by drop_old, attempting LLM compress", { sessionID })
        emitTelemetry("session.hybrid_enrichment.fallback_to_ai_paid")
        const LLM_INPUT_TOKEN_CAP = 30_000
        const llmInputCharCap = LLM_INPUT_TOKEN_CAP * 4
        const llmBody = latestBody.length > llmInputCharCap
          ? latestBody.slice(-llmInputCharCap)
          : latestBody
        const priorAnchor: Hybrid.Anchor = {
          role: "assistant",
          summary: true,
          content: llmBody,
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
            outputTokens: Math.ceil(llmBody.length / 4),
            phase: 1,
          },
        }
        const ctx = model.limit?.context ?? 200_000
        const targetTokens = Math.max(5_000, Math.round(ctx * 0.3))
        const event = await Hybrid.runHybridLlm(sessionID, {
          abort: new AbortController().signal,
          priorAnchor,
          journalUnpinned: [],
          targetTokens,
          voluntary: false,
          busMode: "hybrid_llm_background",
          observed,
        })
        log.info("enrichment step 3 (ai_paid) finished", {
          sessionID,
          result: event.result,
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
        })
        if (event.result !== "success") {
          emitEnrichmentStatus("failed", `ai_paid: ${event.errorCode ?? event.result}`)
          emitRecompressTelemetry({
            ...baseTelemetry,
            result: "provider-error",
            errorMessage: event.errorCode ? String(event.errorCode) : undefined,
            latencyMs: Date.now() - recompressStartedAt,
          })
          return
        }

        // Read hybrid_llm's stub anchor body, then UPDATE the narrative
        // anchor in place. Demote the stub anchor (set summary=false) so
        // Memory.read no longer treats it as an active anchor candidate.
        const messagesPost = await Session.messages({ sessionID }).catch(() => [] as MessageV2.WithParts[])
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
          log.info("hybrid_llm enrichment: stub === narrative anchor, no upgrade needed", { sessionID })
          return
        }
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
          emitRecompressTelemetry({
            ...baseTelemetry,
            result: "stale-anchor-skipped",
            latencyMs: Date.now() - recompressStartedAt,
          })
          return
        }

        const upgradedBody = stubMsg.parts
          .filter((p) => p.type === "text")
          .map((p) => (p as any).text ?? "")
          .join("\n")
        if (!upgradedBody.trim()) {
          log.warn("hybrid_llm enrichment: stub anchor has no text body; leaving narrative anchor unchanged", { sessionID })
          return
        }

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

        await Session.updateMessage({
          ...(stubMsg.info as any),
          summary: false,
        })

        await demoteOldAnchors()

        log.info("hybrid_llm enrichment: upgraded narrative anchor in place", {
          sessionID,
          narrativeAnchorId,
          stubId: stubMsg.info.id,
          upgradedTokens: Math.ceil(upgradedBody.length / 4),
          replacedTokens: narrativeTokens,
        })
        emitRecompressTelemetry({
          ...baseTelemetry,
          result: "success",
          anchorTokensAfter: Math.ceil(upgradedBody.length / 4),
          latencyMs: Date.now() - recompressStartedAt,
        })
        emitEnrichmentStatus("success")
      } catch (err) {
        emitEnrichmentStatus("failed", err instanceof Error ? err.message : String(err))
        log.error("hybrid_llm enrichment threw", {
          sessionID,
          error: err instanceof Error ? err.message : String(err),
        })
        emitRecompressTelemetry({
          sessionID,
          trigger: "legacy-large-policy",
          kind: "hybrid_llm",
          providerId: model.providerId,
          anchorTokensBefore: 0,
          result: "exception",
          errorMessage: err instanceof Error ? err.message : String(err),
          latencyMs: 0,
        })
      } finally {
        hybridEnrichInFlight.delete(sessionID)
      }
    })()
    hybridEnrichInFlight.set(sessionID, { promise, startedAt: Date.now() })
    log.info("hybrid_llm enrichment scheduled (background)", {
      sessionID,
      observed,
    })
  }

  // ───────────────────────────────────────────────────────────────────
  // dialog-replay-redaction DD-4: codex provider recompress dispatch
  //
  // Feeds the anchor body as a single conversationItem to the existing
  // session.compact plugin (codex /responses/compact). On success, the
  // plugin returns a server-distilled summary; we update the anchor's
  // text part in place. Mirrors the staleness check and telemetry
  // surface of the hybrid_llm path so both routes behave identically
  // from the runloop's perspective.
  // ───────────────────────────────────────────────────────────────────

  async function runCodexServerSideRecompress(input: {
    sessionID: string
    anchorMsg: MessageV2.WithParts
    anchorTokensBefore: number
    model: Provider.Model
    trigger: "size-ceiling" | "legacy-large-policy"
    messagesPre: MessageV2.WithParts[]
    /** Called after successful in-place update (e.g. demote old anchors). */
    onSuccess?: () => Promise<void>
    /** Called on any failure path (e.g. surface status to recentEvents). */
    onError?: (reason: string) => Promise<void>
  }): Promise<void> {
    const { sessionID, anchorMsg, anchorTokensBefore, model, trigger, messagesPre } = input
    const startedAt = Date.now()
    const baseTelemetry = {
      sessionID,
      trigger,
      kind: "ai_free" as const,
      providerId: model.providerId,
      anchorTokensBefore,
    }

    let succeeded = false
    try {
      // Send the narrative anchor body as a single assistant message.
      // The anchor is already a compressed dialog context (tool outputs
      // stripped, only conversation skeleton). Let the server compress
      // this prose into an even more compact real anchor.
      const anchorBody = input.anchorMsg.parts
        .filter((p) => p.type === "text")
        .map((p) => (p as any).text ?? "")
        .join("\n")
      const allConversationItems: unknown[] = anchorBody.trim()
        ? [{ type: "message", role: "assistant", content: [{ type: "output_text", text: anchorBody }] }]
        : buildConversationItemsForPlugin(messagesPre) // fallback if anchor has no body

      if (allConversationItems.length === 0) {
        log.warn("codex recompress: no conversation items to compact", { sessionID })
        emitRecompressTelemetry({
          ...baseTelemetry,
          result: "exception",
          errorMessage: "no conversation items",
          latencyMs: Date.now() - startedAt,
        })
        return
      }

      const lastUser = messagesPre.findLast((m) => m.info.role === "user")?.info as MessageV2.User | undefined
      // Resolve accountId from session execution (pinned by rotation),
      // falling back to last user message or anchor message.
      const sessionExec = (await Session.get(sessionID).catch(() => undefined))?.execution
      const accountId = sessionExec?.accountId
        ?? lastUser?.model?.accountId
        ?? (anchorMsg.info as MessageV2.Assistant).accountId
      const agent = lastUser?.agent ? await Agent.get(lastUser.agent).catch(() => undefined) : undefined
      const instructions = (agent?.prompt ?? "").slice(0, 50_000)

      // Batched compaction: codex /responses/compact empirically handles
      // ~1000-1200 items. Split into batches of BATCH_SIZE, compact each
      // independently, then join the summary texts to form the anchor body.
      const BATCH_SIZE = 1500
      const batches: unknown[][] = []
      for (let i = 0; i < allConversationItems.length; i += BATCH_SIZE) {
        batches.push(allConversationItems.slice(i, i + BATCH_SIZE))
      }

      log.info("codex recompress: batched compaction", {
        sessionID,
        totalItems: allConversationItems.length,
        batches: batches.length,
        batchSizes: batches.map(b => b.length),
        anchorTokensBefore,
      })

      const summaries: string[] = []
      const allCompactedItems: unknown[] = []
      for (let i = 0; i < batches.length; i++) {
        const batch = batches[i]
        let hookResult: { compactedItems: unknown[] | null; summary: string | null }
        try {
          hookResult = (await Plugin.trigger(
            "session.compact",
            {
              sessionID,
              model: { providerId: model.providerId, modelID: model.id, accountId },
              conversationItems: batch,
              instructions,
            },
            { compactedItems: null as unknown[] | null, summary: null as string | null },
          )) as { compactedItems: unknown[] | null; summary: string | null }
        } catch (err) {
          log.warn("codex recompress: batch plugin threw", {
            sessionID,
            batch: i,
            batchItems: batch.length,
            error: err instanceof Error ? err.message : String(err),
          })
          emitRecompressTelemetry({
            ...baseTelemetry,
            result: "provider-error",
            errorMessage: `batch ${i}/${batches.length} threw: ${err instanceof Error ? err.message : String(err)}`,
            latencyMs: Date.now() - startedAt,
          })
          return
        }

        if (!hookResult.compactedItems) {
          log.info("codex recompress: batch plugin did not handle", {
            sessionID,
            batch: i,
            batchItems: batch.length,
          })
          emitRecompressTelemetry({
            ...baseTelemetry,
            result: "provider-error",
            errorMessage: `batch ${i}/${batches.length} not handled (${batch.length} items)`,
            latencyMs: Date.now() - startedAt,
          })
          return
        }

        // Collect compacted items from all batches (typically 1 batch for
        // anchor-body input). Summary text is best-effort — server may
        // return only compaction_summary (encrypted blob) with no message.
        allCompactedItems.push(...(hookResult.compactedItems as unknown[]))
        if (hookResult.summary?.trim()) {
          summaries.push(hookResult.summary.trim())
        }
        log.info("codex recompress: batch succeeded", {
          sessionID,
          batch: i,
          inputItems: batch.length,
          compactedItemCount: (hookResult.compactedItems as unknown[]).length,
        })
      }

      // STALENESS CHECK: re-read the anchor; if a newer one has been
      // written since we dispatched, abandon the in-place update.
      const messagesPost = await Session.messages({ sessionID }).catch(() => [] as MessageV2.WithParts[])
      const currentAnchor = await Memory.Hybrid.getAnchorMessage(sessionID, messagesPost)
      if (!currentAnchor || currentAnchor.info.id !== anchorMsg.info.id) {
        log.info("codex recompress: stale anchor detected; skipping in-place update", {
          sessionID,
          dispatchedAnchorID: anchorMsg.info.id,
          currentAnchorID: currentAnchor?.info.id,
        })
        emitRecompressTelemetry({
          ...baseTelemetry,
          result: "stale-anchor-skipped",
          latencyMs: Date.now() - startedAt,
        })
        return
      }

      // Store compactedItems + chainBinding in the anchor's compaction
      // part metadata. Narrative text body is NOT overwritten — it stays
      // for human readability, sidebar display, and non-codex fallback.
      const compactionPart = currentAnchor.parts.find((p) => p.type === "compaction")
      if (!compactionPart) {
        log.warn("codex recompress: anchor has no compaction part", { sessionID })
        emitRecompressTelemetry({
          ...baseTelemetry,
          result: "exception",
          errorMessage: "anchor has no compaction part",
          latencyMs: Date.now() - startedAt,
        })
        return
      }

      await Session.updatePart({
        ...(compactionPart as any),
        metadata: {
          ...((compactionPart as any).metadata ?? {}),
          serverCompactedItems: allCompactedItems,
          chainBinding: {
            accountId,
            modelId: model.id,
            capturedAt: Date.now(),
          },
        },
      })

      log.info("codex recompress: stored encrypted anchor in metadata", {
        sessionID,
        anchorId: anchorMsg.info.id,
        compactedItemCount: allCompactedItems.length,
        hasEncryptedBlob: allCompactedItems.some((i: any) => i.type === "compaction_summary"),
        narrativeBodyPreserved: true,
      })
      // Post-success hook: demote old anchors when merging N→1.
      succeeded = true
      if (input.onSuccess) await input.onSuccess().catch(() => undefined)
      emitRecompressTelemetry({
        ...baseTelemetry,
        result: "success",
        anchorTokensAfter: allCompactedItems.length,
        latencyMs: Date.now() - startedAt,
      })
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      const errStack = err instanceof Error ? err.stack : undefined
      log.error("codex recompress threw", { sessionID, error: errMsg, stack: errStack })
      emitRecompressTelemetry({
        ...baseTelemetry,
        result: "exception",
        errorMessage: errMsg,
        latencyMs: Date.now() - startedAt,
      })
    } finally {
      if (!succeeded && input.onError) {
        await input.onError("codex recompress failed").catch(() => undefined)
      }
    }
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

    // Firefight (context/claude-refactor DD-4 / INV-3): claude is stateless,
    // full-retransmit, 1M context — it has no server chain to rebind. The
    // codex chain-rebind observeds (provider-switched / rebind /
    // continuation-invalidated) must NOT trigger compaction on claude; doing
    // so forged the stale narrative anchor that broke ses_18d7f02e. No-op
    // here and let the next turn full-retransmit the neutral SQLite. Genuine
    // token pressure (overflow/idle) and user `manual` still compact claude.
    // codex/other providers are unaffected (INV-0).
    if (shouldSkipClaudeEventCompaction(model?.providerId, observed)) {
      log.info("compaction.claude_event_noop", { sessionID, observed, providerId: model?.providerId, step })
      emitCompactionPredicateTelemetry({
        sessionID,
        step,
        outcome: "block",
        reason: "claude-event-noop",
        observed,
      })
      return "continue"
    }

    const ctxRatio = await sessionContextRatio(sessionID, model)
    const isSubscription = isSubscriptionCostModel(model)
    const byRequest = model ? !isByTokenBilling(model) : false
    const baseChain = resolveKindChain({
      observed,
      providerId: model?.providerId,
      isSubscription,
      ctxRatio,
      byRequest,
    })
    // Manual --rich OR by-request manual: skip narrative and go straight to
    // llm-agent. By-request providers (copilot) have tiny context windows —
    // narrative append doesn't shrink context, only ai_paid does.
    const forceRich = intent === "rich" || (observed === "manual" && byRequest)
    const chain: ReadonlyArray<KindName> =
      observed === "manual" && forceRich ? (["ai_paid"] as const) : baseChain
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
    // 2026-05-13 rev2 (specs/session/rebind-procedure-revision/events/
    // event_2026-05-12_rev2-hybrid-llm-enrichment-rarely-observed-eligibi.md):
    // rebind / continuation-invalidated / provider-switched / stall-recovery
    // were previously excluded from hybrid_llm enrichment under the implicit
    // "rebind = small context" assumption. Rotation-heavy sessions falsify
    // that assumption: narrative anchors chain linearly without LLM-driven
    // size reduction. Adding these to the eligible set lets the background
    // hybrid_llm enrichment dissolve stacked narrative anchors into a single
    // distilled quality anchor for these triggers too. Leave `idle` out
    // (no pressure → don't burn LLM tokens) and `empty-response` out
    // (already uses low-cost-server as first attempt).
    const hybridEnrichmentEligible: ReadonlySet<Observed> = new Set([
      "overflow",
      "cache-aware",
      "manual",
      "rebind",
      "continuation-invalidated",
      "provider-switched",
      "stall-recovery",
    ])

    const target = await resolveTargetPromptTokens()
    const hasPaidKindLater = (idx: number) => chain.slice(idx + 1).some((k) => !isLocalKind(k))

    // user-msg-replay-unification DD-3: snapshot the unanswered user
    // message ONCE at the start of run(), before any kind fires. Pass
    // it through to anchor write paths so post-anchor replay can rewrite
    // the user msg with id > anchor.id. Single-runloop-per-session
    // invariant means no concurrent stream writes during the chain.
    const tweaks = Tweaks.compactionSync()
    const replayEnabled = (tweaks as { enableUserMsgReplay?: boolean }).enableUserMsgReplay !== false
    const preReplaySnapshot = replayEnabled
      ? await snapshotUnansweredUserMessage(sessionID, observed).catch(() => undefined)
      : undefined

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
          // Skip _writeAnchor; replay the snapshotted user msg first
          // (so post-anchor stream is settled before Continue decision),
          // THEN ask the runtime gate whether to inject Continue.
          //
          // user-msg-replay-unification DD-3 + DD-4: replay before
          // injectContinue means shouldInjectContinue's runtime check
          // sees the replayed user msg and correctly skips Continue
          // injection. Helper never throws.
          if (preReplaySnapshot) {
            const newAnchorId = await readMostRecentAnchorId(sessionID)
            if (newAnchorId) {
              log.info("compaction.replay.invoked", {
                sessionID,
                observed,
                step,
                callSite: "run_anchorWritten",
                anchorMessageID: newAnchorId,
                snapshotUserID: preReplaySnapshot.info.id,
              })
              await _replayHelper({
                sessionID,
                snapshot: preReplaySnapshot,
                anchorMessageID: newAnchorId,
                observed,
                step,
              })
            } else {
              log.info("compaction.replay.skipped", {
                sessionID,
                observed,
                step,
                callSite: "run_anchorWritten",
                reason: "no_anchor_id_after_inline_write",
              })
            }
          } else {
            log.info("compaction.replay.skipped", {
              sessionID,
              observed,
              step,
              callSite: "run_anchorWritten",
              reason: "no_snapshot",
            })
          }
          if (replayEnabled) {
            const anchorIdForGate = await readMostRecentAnchorId(sessionID)
            if (anchorIdForGate && (await shouldInjectContinue(sessionID, observed, anchorIdForGate))) {
              await injectContinueAfterAnchor(sessionID, observed)
            }
          } else if (INJECT_CONTINUE[observed]) {
            // Legacy fallback (flag disabled): direct INJECT_CONTINUE
            // table check, no runtime gate.
            await injectContinueAfterAnchor(sessionID, observed)
          }
        } else if (model) {
          await _writeAnchor({
            sessionID,
            summaryText: attempt.summaryText,
            model,
            auto: INJECT_CONTINUE[observed],
            kind: attempt.kind,
            serverCompactedItems: attempt.serverCompactedItems,
            chainBinding: attempt.chainBinding,
            observed,
            step,
            snapshot: preReplaySnapshot,
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
          console.error(`[ENRICH-CALL] observed=${observed} kind=${attempt.kind} session=${sessionID}`)
          scheduleHybridEnrichment(sessionID, observed, model)
        } else {
          console.error(`[ENRICH-INELIGIBLE] observed=${observed} session=${sessionID}`)
        }
        // compaction_simplification T8 (2026-05-14): rev5 sustainability
        // watermark backstop retired. The 0.9 overflowThreshold (codex
        // tuned) is now the sole synchronous overflow guard. The 20%
        // local→ai_paid upgrade trigger (T4) provides preemptive size
        // control without the watermark recursion machinery.
        // Some kinds (low-cost-server) do not self-publish Event.Compacted;
        // others (compactWithSharedContext / tryLlmAgent / tryHybridLlm) do.
        // Publishing here for the kinds that don't ensures the frontend
        // statusFooter reliably clears on every successful exit.
        if (attempt.kind === "ai_free") {
          void publishCompactedAndResetChain(sessionID, { observed, kind: attempt.kind })
        }
        return "continue"
      }
    }

    log.warn("compaction.chain_exhausted", { sessionID, observed, step })
    // Chain exhausted without writing an anchor — still publish Compacted
    // so the frontend statusFooter clears (otherwise spinner sticks
    // indefinitely after a silent failure).
    void publishCompactedAndResetChain(sessionID, { observed, success: false })
    return "stop"
  }

  /** Inject the synthetic Continue user message only when PostCompaction
   * intentionally emits non-empty text. Runtime-state resend is retired; most
   * paths should skip this entirely and rely on structured authorities.
   */
  async function injectContinueAfterAnchor(sessionID: string, observed: Observed) {
    const messages = await Session.messages({ sessionID }).catch(() => [])
    const userMessage = messages.findLast((m) => m.info.role === "user")?.info as MessageV2.User | undefined
    if (!userMessage) {
      log.warn("compaction.run injectContinue: no user message found, skipping", { sessionID, observed })
      log.info("compaction.continue.injected", { sessionID, observed, decision: false, reason: "no_user_message" })
      return
    }
    const followUps = await PostCompaction.gather(sessionID).catch(() => [])
    const continueText = PostCompaction.buildContinueText(followUps)
    if (!continueText) {
      log.info("compaction.continue.injected", {
        sessionID,
        observed,
        decision: false,
        reason: "empty_continue_text",
        followUpCount: Array.isArray(followUps) ? followUps.length : -1,
      })
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
      text: continueText,
      time: { start: Date.now(), end: Date.now() },
    })
    log.info("compaction.continue.injected", {
      sessionID,
      observed,
      decision: true,
      continueMsgId: continueMsg.id,
      textLength: continueText.length,
      followUpCount: Array.isArray(followUps) ? followUps.length : -1,
    })
  }

  /**
   * user-msg-replay-unification DD-4: the runtime gate that decides whether
   * a synthetic Continue should follow a freshly written anchor.
   *
   * Combines TWO gates in conjunction:
   *   1. Static intent (INJECT_CONTINUE[observed]): preserves the R-6
   *      rule that rebind / continuation-invalidated / provider-switched
   *      / stall-recovery / manual must NEVER inject Continue (avoids
   *      the 2026-04-27 infinite loop bug). Same observed-value
   *      semantics as the legacy table.
   *   2. Stream state: even when intent says "inject", skip if a real
   *      user message already exists post-anchor (the replayed user
   *      msg from Spec 1's helper, OR a /compact request msg, OR any
   *      other concurrent user write). Prevents the model from seeing
   *      both the user's actual question AND a synthetic Continue
   *      directive in the same iteration.
   */
  async function shouldInjectContinue(
    sessionID: string,
    observed: Observed,
    anchorMessageID: string,
  ): Promise<boolean> {
    // 2026-05-13 amend (specs/compaction/user-msg-replay-unification +
    // specs/session/rebind-procedure-revision rev4): for the false-default
    // cases (rebind / continuation-invalidated / provider-switched /
    // stall-recovery / manual), allow Continue injection if a chain-init
    // pending mark exists. The mark is the signal of a real user-initiated
    // chain-break event that flowed through Continuation.run (admin PATCH,
    // explicit account_switch dispatch, …) — i.e. the user is mid-prompt
    // and expects work to continue.
    //
    // 2026-04-27 regression defence: phantom-rebind-detection (the
    // processor.ts:707 mid-stream "account changed" false positive that
    // produced the original infinite-loop bug) operates entirely inside
    // the processor, does NOT route through Continuation.run, and
    // therefore does NOT write a PendingInjectionStore mark. So the
    // override path here only fires for genuinely user-initiated
    // rebind / provider-switch / model-switch events, preserving the
    // belt-and-suspenders defence against the original bug class.
    const staticIntent = INJECT_CONTINUE[observed]
    let overrideUsed = false
    if (!staticIntent) {
      try {
        const { PendingInjectionStore } = await import("./continuation/pending-injection")
        const pending = PendingInjectionStore.peek(sessionID)
        if (!pending || !pending.chainInit) {
          log.info("compaction.continue.gate", {
            sessionID,
            observed,
            anchorMessageID,
            decision: false,
            reason: "static_intent_false_no_chain_init_pending",
            staticIntent,
            chainInitPending: !!pending?.chainInit,
          })
          return false
        }
        // chain-init pending → real user-initiated event → fall through
        overrideUsed = true
      } catch {
        // continuation module not loadable → preserve legacy behaviour
        log.info("compaction.continue.gate", {
          sessionID,
          observed,
          anchorMessageID,
          decision: false,
          reason: "pending_injection_module_unavailable",
          staticIntent,
        })
        return false
      }
    }
    const messages = await Session.messages({ sessionID }).catch(() => [] as MessageV2.WithParts[])
    const hasUserMsgPostAnchor = messages.some((m) => m.info.role === "user" && m.info.id > anchorMessageID)
    const decision = !hasUserMsgPostAnchor
    log.info("compaction.continue.gate", {
      sessionID,
      observed,
      anchorMessageID,
      decision,
      reason: decision
        ? overrideUsed
          ? "no_post_anchor_user_via_chain_init_override"
          : "no_post_anchor_user_static_intent"
        : "post_anchor_user_exists",
      staticIntent,
      overrideUsed,
      hasUserMsgPostAnchor,
    })
    return decision
  }

  // ───────────────────────────────────────────────────────────────────
  // User-message replay (spec compaction/user-msg-replay-unification)
  //
  // Background:
  //   When compaction writes a new anchor (any kind), filterCompacted
  //   slices the messages stream at the anchor's `compaction` part, so
  //   any user message with id < anchor.id becomes invisible to the next
  //   runloop iteration. If that user message is the user's most recent
  //   (still-unanswered) question, the runloop's `lastUser` resolves to
  //   undefined OR to a synthetic `Continue from where you left off`
  //   message — silently dropping the user's actual ask.
  //
  // The 2026-05-05 hotfix (commit a3be0500e) patched ONE call site
  // inline at prompt.ts:1484-1554. The 2026-05-09 production incident
  // (session ses_1f47aa711...) confirmed three sibling commit paths
  // share the same defect (overflow / rebind pre-emptive / provider-
  // switch pre-loop). This module-internal helper centralises the
  // replay so all four commit paths inherit the post-condition:
  //   "if an unanswered user message existed pre-compaction, an
  //    unanswered user message exists post-compaction with id > anchor.id."
  // ───────────────────────────────────────────────────────────────────

  export interface UserMessageSnapshot {
    info: MessageV2.User
    parts: MessageV2.Part[]
    /**
     * Optional. When the unanswered user message has a child assistant
     * with empty/error finish (e.g. the 5/5 empty-response self-heal
     * scenario), the helper will delete that empty child along with the
     * original user message to keep the UI clean.
     */
    emptyAssistantID?: string
  }

  export type ReplayResult = {
    replayed: boolean
    newUserID?: string
    reason?:
      | "already-after-anchor"
      | "no-unanswered"
      | "snapshot-already-consumed"
      | "feature-flag-disabled"
      | "exception"
  }

  /**
   * Walk the session messages stream backward to identify the most recent
   * UNANSWERED user message: one whose nearest subsequent assistant child
   * has finish ∉ {stop, tool-calls, length} (or no assistant child yet).
   *
   * Returns a snapshot caller can pass to `replayUnansweredUserMessage`
   * after a compaction anchor write. Returns undefined when:
   *   - the stream has no user message
   *   - the most recent user message has a properly finished assistant
   *     child (= already answered, no replay needed)
   *
   * 2026-05-25 overflow-replay-length-fix:
   *   - Path A: when observed === "overflow", finish=length is treated as
   *     unanswered (length-truncation is the literal symptom of overflow,
   *     not a completed answer). Other observed values keep length-as-
   *     answered semantics (e.g. user asked for a deliberately long doc
   *     and the model legitimately ran to length).
   *   - Path B: skip user messages whose only parts are compaction-request
   *     placeholders (written by SessionCompaction.create when the LLM
   *     itself throws ContextOverflowError). Walking past them finds the
   *     real user request that triggered the in-flight turn so replay
   *     carries the actual intent across the anchor.
   *
   * Pure read function. Does not mutate storage. Caller may pass an
   * already-loaded `messages` array to avoid a second fetch.
   */
  export async function snapshotUnansweredUserMessage(
    sessionID: string,
    observed: Observed,
    messages?: MessageV2.WithParts[],
  ): Promise<UserMessageSnapshot | undefined> {
    const msgs = messages ?? (await Session.messages({ sessionID }).catch(() => [] as MessageV2.WithParts[]))
    if (msgs.length === 0) {
      log.info("compaction.snapshot.skipped", { sessionID, observed, reason: "no_messages" })
      return undefined
    }

    let userIdx = -1
    let placeholdersSkipped = 0
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      if (m.info.role !== "user") continue
      // Path B: skip compaction-request placeholders so replay carries the
      // real user intent, not the synthetic "please compact" marker.
      if (m.parts.length > 0 && m.parts.every((p) => p.type === "compaction-request")) {
        placeholdersSkipped++
        continue
      }
      userIdx = i
      break
    }
    if (userIdx === -1) {
      log.info("compaction.snapshot.skipped", {
        sessionID,
        observed,
        reason: "no_real_user_msg",
        totalMessages: msgs.length,
        placeholdersSkipped,
      })
      return undefined
    }

    const userMsg = msgs[userIdx]

    // Walk ALL assistant children of this user msg (until next user msg / end).
    // assistantChild keeps the FIRST (current snapshot semantics), but the
    // chain inventory is captured for telemetry so we can detect mid-tool-
    // call-chain overflow scenarios where the first child's finish is
    // tool-calls but no terminal stop ever arrived. 2026-05-25 instrumentation.
    let assistantChild: MessageV2.WithParts | undefined
    let chainLen = 0
    let firstStopIdx = -1
    let lastChildFinish: MessageV2.Assistant["finish"] | undefined
    for (let i = userIdx + 1; i < msgs.length; i++) {
      const m = msgs[i]
      if (m.info.role !== "assistant") break
      if (!assistantChild) assistantChild = m
      chainLen++
      const f = (m.info as MessageV2.Assistant).finish
      lastChildFinish = f
      if (firstStopIdx === -1 && f === "stop") firstStopIdx = chainLen
    }

    // "Properly finished" = assistant ran to completion in a way that
    // resolves the user's question. unknown / error / other / undefined
    // all signal an interrupted or empty turn — user msg is unanswered.
    if (assistantChild) {
      const finish = (assistantChild.info as MessageV2.Assistant).finish
      const lengthIsAnswered = observed !== "overflow"
      if (finish === "stop" || finish === "tool-calls" || (lengthIsAnswered && finish === "length")) {
        log.info("compaction.snapshot.skipped", {
          sessionID,
          observed,
          reason: "first_child_answered",
          firstChildFinish: finish,
          chainLen,
          lastChildFinish,
          firstStopIdx, // -1 if no stop anywhere in chain; positive if stop reached at that position
          placeholdersSkipped,
          userMsgId: userMsg.info.id,
        })
        return undefined
      }
    }

    log.info("compaction.snapshot.captured", {
      sessionID,
      observed,
      userMsgId: userMsg.info.id,
      hasAssistantChild: !!assistantChild,
      firstChildFinish: assistantChild ? (assistantChild.info as MessageV2.Assistant).finish : undefined,
      chainLen,
      lastChildFinish,
      firstStopIdx,
      placeholdersSkipped,
    })

    return {
      info: { ...(userMsg.info as MessageV2.User) },
      parts: userMsg.parts.map((p) => ({ ...p }) as MessageV2.Part),
      emptyAssistantID: assistantChild?.info.id,
    }
  }

  /**
   * Replay an unanswered user message AFTER a freshly-written compaction
   * anchor so it lands post-anchor with id > anchor.id. Idempotent under
   * retry; never throws (helper failure must not stall the runloop —
   * degrades to today's pre-fix behaviour).
   *
   * Strategy (DD-2 in spec design.md):
   *   1. Honour `enableUserMsgReplay` feature flag (default true)
   *   2. If snapshot.id > anchorMessageID, skip — already after anchor
   *   3. Verify snapshot is still in the stream (idempotency under retry)
   *   4. Write new user msg with fresh ULID, copy parts with fresh ids
   *   5. Remove emptyAssistantID + remove original user msg
   *   6. Emit telemetry (every branch, including skip / error)
   *
   * Telemetry surface: `compaction.user_msg_replay` (per
   * compaction-telemetry.ts emitUserMsgReplayTelemetry).
   */
  export async function replayUnansweredUserMessage(input: {
    sessionID: string
    snapshot: UserMessageSnapshot
    anchorMessageID: string
    observed: Observed
    step: number
  }): Promise<ReplayResult> {
    const tweaks = Tweaks.compactionSync()
    const flag = (tweaks as { enableUserMsgReplay?: boolean }).enableUserMsgReplay
    const originalUserID = input.snapshot.info.id
    const baseTelemetry = {
      sessionID: input.sessionID,
      step: input.step,
      observed: input.observed,
      originalUserID,
      anchorMessageID: input.anchorMessageID,
      hadEmptyAssistantChild: !!input.snapshot.emptyAssistantID,
      partCount: input.snapshot.parts.length,
    }

    if (flag === false) {
      emitUserMsgReplayTelemetry({ ...baseTelemetry, outcome: "skipped:flag-off" })
      log.info("self-heal: replay skipped — feature flag off", {
        sessionID: input.sessionID,
        step: input.step,
        originalUserID,
      })
      return { replayed: false, reason: "feature-flag-disabled" }
    }

    if (originalUserID > input.anchorMessageID) {
      emitUserMsgReplayTelemetry({ ...baseTelemetry, outcome: "skipped:already-after-anchor" })
      log.info("self-heal: replay skipped — snapshot already after anchor", {
        sessionID: input.sessionID,
        step: input.step,
        originalUserID,
        anchorMessageID: input.anchorMessageID,
      })
      return { replayed: false, reason: "already-after-anchor" }
    }

    // Idempotency: if a previous helper invocation already consumed this
    // snapshot, the original user msg won't be in the stream anymore.
    const stillExists = await Session.messages({ sessionID: input.sessionID })
      .then((msgs) => msgs.some((m) => m.info.id === originalUserID))
      .catch(() => true) // on read failure, attempt write anyway and let exception path catch
    if (!stillExists) {
      emitUserMsgReplayTelemetry({ ...baseTelemetry, outcome: "skipped:no-unanswered" })
      log.info("self-heal: replay skipped — original snapshot already consumed", {
        sessionID: input.sessionID,
        step: input.step,
        originalUserID,
      })
      return { replayed: false, reason: "snapshot-already-consumed" }
    }

    try {
      const newUserID = Identifier.ascending("message")
      const newUser: MessageV2.User = {
        ...input.snapshot.info,
        id: newUserID,
        time: { created: Date.now() },
      }
      await Session.updateMessage(newUser)
      for (const part of input.snapshot.parts) {
        const copy = {
          ...part,
          id: Identifier.ascending("part"),
          messageID: newUserID,
        } as MessageV2.Part
        // Tag text parts so the frontend can suppress the replayed bubble
        // from the visible conversation (the user already saw the original).
        // Backend treats this as a normal user message (synthetic flag untouched).
        if (copy.type === "text") {
          ;(copy as MessageV2.TextPart).metadata = {
            ...((part as MessageV2.TextPart).metadata || {}),
            compactionReplay: true,
          }
        }
        await Session.updatePart(copy)
      }
      if (input.snapshot.emptyAssistantID) {
        await Session.removeMessage({
          sessionID: input.sessionID,
          messageID: input.snapshot.emptyAssistantID,
        })
      }
      await Session.removeMessage({ sessionID: input.sessionID, messageID: originalUserID })

      log.info("self-heal: replayed user message after anchor", {
        sessionID: input.sessionID,
        step: input.step,
        observed: input.observed,
        originalUserID,
        newUserID,
        anchorMessageID: input.anchorMessageID,
        emptyAssistantID: input.snapshot.emptyAssistantID,
        partCount: input.snapshot.parts.length,
      })

      emitUserMsgReplayTelemetry({ ...baseTelemetry, outcome: "replayed", newUserID })

      return { replayed: true, newUserID }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      log.error("self-heal: replay-after-compact failed; user message may be hidden behind anchor", {
        sessionID: input.sessionID,
        step: input.step,
        observed: input.observed,
        originalUserID,
        anchorMessageID: input.anchorMessageID,
        error: errorMessage,
      })
      emitUserMsgReplayTelemetry({
        ...baseTelemetry,
        outcome: "error",
        errorMessage,
      })
      return { replayed: false, reason: "exception" }
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Session healing: text-only stream rebuild (/reload Step 3)
  //
  // Reads all messages from DB, extracts only user text + assistant
  // text (what the user saw in the UI), discards everything else
  // (tool calls, step markers, synthetic messages, old anchors).
  // Writes a single clean narrative anchor with amnesia header.
  // Demotes ALL old anchors. Resets codex chain.
  // ─────────────────────────────────────────────────────────────

  export async function rebuildStreamFromText(sessionID: string): Promise<{
    roundsIncluded: number
    charsBudget: number
    charsUsed: number
  }> {
    const model = await resolveActiveModel(sessionID)
    const contextWindow = model?.limit?.context ?? 200_000
    const charBudget = Math.floor(contextWindow * 0.2) * 4 // 20% of context, ~4 chars/token

    // Read all messages from DB
    const allMsgs = await Session.messages({ sessionID }).catch(() => [] as MessageV2.WithParts[])

    // Extract text-only rounds: walk backwards from tail
    const rounds: Array<{ role: "user" | "assistant"; text: string }> = []
    let totalChars = 0

    for (let i = allMsgs.length - 1; i >= 0 && totalChars < charBudget; i--) {
      const msg = allMsgs[i]
      const info = msg.info

      // Skip compaction anchors (summary=true) — DD-7: discard old summaries
      if (info.role === "assistant" && (info as MessageV2.Assistant).summary === true) continue

      // Extract only non-synthetic text parts (what the user saw in UI)
      const textParts = msg.parts.filter((p) => {
        if (p.type !== "text") return false
        if ((p as { synthetic?: boolean }).synthetic) return false
        const text = (p as { text?: string }).text
        return typeof text === "string" && text.length > 0
      })

      if (textParts.length === 0) continue

      const combinedText = textParts
        .map((p) => (p as { text: string }).text)
        .join("\n")
        .trim()

      if (!combinedText) continue

      const role = info.role as "user" | "assistant"
      rounds.unshift({ role, text: combinedText })
      totalChars += combinedText.length
    }

    // Build anchor body
    const amnesiaHeader = [
      "---",
      "\u2139\ufe0f Session context was compacted \u2014 only a short narrative anchor is in your prompt.",
      "Full tool call history, reasoning, and patch records ARE PRESERVED in the session database.",
      "Use the `session_recall` tool to query past actions, outputs, or reasoning when you need them.",
      "Re-read files directly via `read` if you need current bytes.",
      "---",
      "",
    ].join("\n")

    let roundNumber = 0
    const roundBodies: string[] = []
    for (const round of rounds) {
      if (round.role === "user") roundNumber++
      const label = round.role === "user" ? `## Round ${roundNumber} (user)` : `## Round ${roundNumber} (assistant)`
      roundBodies.push(`${label}\n${round.text}`)
    }

    const anchorBody = amnesiaHeader + roundBodies.join("\n\n")

    // Demote ALL existing anchors (DD-5)
    for (const m of allMsgs) {
      if (m.info.role !== "assistant") continue
      if ((m.info as MessageV2.Assistant).summary !== true) continue
      await Session.updateMessage({ ...(m.info as any), summary: false }).catch(() => undefined)
    }

    // Find model info for the anchor message
    const lastUser = allMsgs.findLast((m) => m.info.role === "user")?.info as MessageV2.User | undefined
    const anchorModel = model ?? { id: "unknown", providerId: "unknown" }
    const accountId = await resolveAccountId(sessionID, lastUser)

    // Write new anchor
    const parentID = allMsgs.at(-1)?.info.id
    if (parentID) {
      const summaryMsg = (await Session.updateMessage({
        id: Identifier.ascending("message"),
        role: "assistant",
        parentID,
        sessionID,
        mode: "compaction",
        agent: "compaction",
        variant: lastUser?.variant,
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
        modelID: anchorModel.id,
        providerId: anchorModel.providerId,
        accountId,
        time: { created: Date.now() },
      })) as MessageV2.Assistant

      await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID: summaryMsg.id,
        sessionID,
        type: "text",
        text: anchorBody,
        time: { start: Date.now(), end: Date.now() },
      })

      await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID: summaryMsg.id,
        sessionID,
        type: "compaction",
        auto: false,
      })
    }

    // Chain reset
    void publishCompactedAndResetChain(sessionID, {
      observed: "reload",
      kind: "text-only rebuild",
    })

    log.info("rebuildStreamFromText complete", {
      sessionID,
      roundsIncluded: roundNumber,
      charsBudget: charBudget,
      charsUsed: totalChars,
    })

    return {
      roundsIncluded: roundNumber,
      charsBudget: charBudget,
      charsUsed: totalChars,
    }
  }

  /**
   * Replay-helper indirection. Internal compaction call sites
   * (defaultWriteAnchor, tryLlmAgent post-anchor, the provider-switch
   * pre-loop adapter in prompt.ts) call `_replayHelper` so tests can
   * substitute a mock via `__test__.setReplayHelper`.
   */
  let _replayHelper = replayUnansweredUserMessage

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
    /** compaction-fix Phase 2 (DD-8). */
    serverCompactedItems?: unknown[]
    /** compaction-fix Phase 2 (DD-9). */
    chainBinding?: { accountId: string; modelId: string; capturedAt: number }
    /**
     * Spec user-msg-replay-unification DD-3: observed condition + step
     * threaded through so post-anchor replay can emit telemetry with
     * full caller context. Snapshot is captured by run() before the
     * kind chain fires so the user msg state is the same one the
     * anchor was decided against.
     */
    observed: Observed
    step: number
    snapshot?: UserMessageSnapshot
  }
  const defaultWriteAnchor = async (input: WriteAnchorInput) => {
    // compaction/recall-affordance L1: server-side TOOL_INDEX injection.
    // The narrative / replay-tail / llm-agent kinds build their body in
    // local code without LLM in the loop, so a prompt-side instruction
    // (buildUserPayload) cannot reach them. We compute the index
    // authoritatively from the on-disk message stream and append it before
    // sanitization. For hybrid_llm we deduplicate against any LLM-emitted
    // table.
    let augmentedSummary = input.summaryText
    const needsClientSideIndex =
      input.kind === "narrative" ||
      input.kind === "ai_paid"
    if (needsClientSideIndex) {
      try {
        const allMsgs = await Session.messages({ sessionID: input.sessionID }).catch(() => [] as MessageV2.WithParts[])
        // Scan the full pre-write message stream for ToolPart entries —
        // these are the calls that will collapse into the anchor body
        // once it lands. Wrap as a single pseudo-journal-entry so the
        // shared extractor works.
        const fresh = ToolIndex.extractFromJournal([{ messages: allMsgs }])
        const priorBody = (() => {
          // priorAnchor's body is already inside input.summaryText for the
          // redacted-dialog path (concat); separate parse is harmless if
          // not present.
          return ToolIndex.parseFromBody(input.summaryText)
        })()
        const merged = ToolIndex.merge(priorBody, fresh)
        if (merged.length > 0) {
          // Apply size ceiling: cap index at ~30K bytes (≤10% of typical
          // anchor body). Older entries truncated with placeholder row.
          const { entries: budgeted, truncatedCount } = ToolIndex.applyBudget(merged, 30_000)
          const section = ToolIndex.renderSection(budgeted)
          // Strip ALL pre-existing TOOL_INDEX sections from the body before
          // appending the authoritative one. Narrative path concatenates
          // prevAnchor.content (which already carries a TOOL_INDEX from the
          // previous compaction) with new dialog tail — a naive slice-at-
          // first-marker drops the tail. stripToolIndexSections walks every
          // marker occurrence and removes each section through to its
          // terminating blank line.
          const stripped = ToolIndex.stripAllSections(input.summaryText)
          augmentedSummary = stripped.trimEnd() + "\n\n" + section
          log.info("compaction.tool_index.injected", {
            sessionID: input.sessionID,
            kind: input.kind,
            entryCount: budgeted.length,
            truncatedCount,
            origBytes: input.summaryText.length,
            newBytes: augmentedSummary.length,
          })
        }
      } catch (err) {
        log.warn("compaction.tool_index.inject_failed", {
          sessionID: input.sessionID,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    // DD-6: anchor body is wrapped + softened before persistence so it
    // cannot be misread as system authority by the LLM on next turn.
    const sanitized = sanitizeAnchorToString(augmentedSummary, input.kind as AnchorKind)
    log.info("compaction.anchor.sanitized", {
      sessionID: input.sessionID,
      kind: input.kind,
      originalLength: input.summaryText.length,
      augmentedLength: augmentedSummary.length,
      sanitizedLength: sanitized.body.length,
      imperativePrefixApplied: sanitized.imperativePrefixApplied,
    })

    // compaction/recall-affordance L1: validate TOOL_INDEX presence on the
    // narrative-kind anchor body. Other kinds (low-cost-server / hybrid_llm
    // / replay-tail) either preserve content via provider chain or are
    // exempt by design; we only police the narrative path where loss is
    // unrecoverable without the affordance.
    if (needsClientSideIndex) {
      const indexCheck = ToolIndex.validate(sanitized.body)
      if (indexCheck.found && indexCheck.entryCount > 0) {
        log.info("compaction.tool_index.emitted", {
          sessionID: input.sessionID,
          kind: input.kind,
          entryCount: indexCheck.entryCount,
          indexBytes: indexCheck.indexBytes,
        })
      } else {
        log.warn("compaction.tool_index.missing", {
          sessionID: input.sessionID,
          kind: input.kind,
          markerPresent: indexCheck.found,
          anchorBytes: sanitized.body.length,
        })
      }
    }

    // AI-generated anchors (ai_free / ai_paid) are complete summaries —
    // they become a "zero anchor" that replaces all predecessors. Demote
    // every existing summary:true message so the new anchor is the sole
    // active one. This breaks the chained-concat floor escalation:
    // narrative anchors accumulate (each containing all predecessors),
    // but an AI anchor resets the floor to just its own compressed size.
    if (input.kind === "ai_free" || input.kind === "ai_paid") {
      const allMsgs = await Session.messages({ sessionID: input.sessionID }).catch(() => [] as MessageV2.WithParts[])
      let demoted = 0
      for (const m of allMsgs) {
        if (m.info.role !== "assistant") continue
        if ((m.info as MessageV2.Assistant).summary !== true) continue
        await Session.updateMessage({ ...(m.info as any), summary: false }).catch(() => undefined)
        demoted++
      }
      if (demoted > 0) {
        log.info("compaction.zero_anchor: demoted predecessors before AI anchor write", {
          sessionID: input.sessionID,
          kind: input.kind,
          demoted,
        })
      }
    }

    // DD-9: identify previous anchor BEFORE the write so we can release its
    // pinForAnchor entries afterwards. The cooldown gate (30s) makes
    // back-to-back anchor races negligible in practice.
    const prevAnchorId = await readMostRecentAnchorId(input.sessionID)

    // user-msg-replay-unification DD-4: when the feature flag is on,
    // suppress compactWithSharedContext's inline Continue injection.
    // Continue injection is now decided post-replay by shouldInjectContinue,
    // which honours both the legacy INJECT_CONTINUE intent table AND a
    // runtime stream check (don't inject if a user msg already exists
    // post-anchor — e.g. via Spec 1's replay helper). Flag-disabled mode
    // preserves the legacy auto pass-through.
    const replayTweaks = Tweaks.compactionSync()
    const replayEnabled = (replayTweaks as { enableUserMsgReplay?: boolean }).enableUserMsgReplay !== false
    await writeAnchorFromBody({
      sessionID: input.sessionID,
      snapshot: sanitized.body,
      model: input.model,
      auto: replayEnabled ? false : input.auto,
      observed: input.observed,
    })

    // user-msg-replay-unification DD-3: after the anchor is persisted,
    // if a pre-anchor snapshot of an unanswered user message exists,
    // replay it post-anchor so the next runloop iteration's lastUser
    // resolves to a real message (not the synthetic Continue substitute).
    // Helper is the test-substitutable indirection (`_replayHelper`); on
    // production this is `replayUnansweredUserMessage`. Helper never throws.
    if (input.snapshot) {
      const newAnchorId = await readMostRecentAnchorId(input.sessionID)
      if (newAnchorId && newAnchorId !== prevAnchorId) {
        log.info("compaction.replay.invoked", {
          sessionID: input.sessionID,
          observed: input.observed,
          step: input.step,
          callSite: "defaultWriteAnchor",
          anchorMessageID: newAnchorId,
          snapshotUserID: input.snapshot.info.id,
        })
        await _replayHelper({
          sessionID: input.sessionID,
          snapshot: input.snapshot,
          anchorMessageID: newAnchorId,
          observed: input.observed,
          step: input.step,
        })
      } else {
        log.info("compaction.replay.skipped", {
          sessionID: input.sessionID,
          observed: input.observed,
          step: input.step,
          callSite: "defaultWriteAnchor",
          reason: !newAnchorId ? "no_new_anchor_id" : "anchor_id_unchanged",
          prevAnchorId,
          newAnchorId,
        })
      }
    } else {
      log.info("compaction.replay.skipped", {
        sessionID: input.sessionID,
        observed: input.observed,
        step: input.step,
        callSite: "defaultWriteAnchor",
        reason: "no_snapshot",
      })
    }

    // user-msg-replay-unification DD-4: post-replay Continue decision.
    // Runtime gate: skip if a user msg already exists post-anchor (the
    // replayed user msg, or a /compact request msg, etc.). Static gate:
    // skip for observed values that historically forbade Continue (R-6
    // rebind / continuation-invalidated / provider-switched / etc.).
    if (replayEnabled) {
      const newAnchorId = await readMostRecentAnchorId(input.sessionID)
      if (newAnchorId && (await shouldInjectContinue(input.sessionID, input.observed, newAnchorId))) {
        await injectContinueAfterAnchor(input.sessionID, input.observed)
      }
    }

    // DD-9: scan the just-written anchor body for skill name references and
    // pin matched active/summary skills so they survive idle decay until the
    // next anchor supersedes this one. Snapshot is logged as telemetry only
    // for Phase A; full anchor.metadata.skillSnapshot persistence is Phase B
    // (requires CompactionPart schema extension).
    await annotateAnchorWithSkillState({
      sessionID: input.sessionID,
      summaryText: sanitized.body,
      prevAnchorId,
      kind: input.kind,
      serverCompactedItems: input.serverCompactedItems,
      chainBinding: input.chainBinding,
    })
  }

  async function readMostRecentAnchorId(sessionID: string): Promise<string | undefined> {
    const messages = await Session.messages({ sessionID }).catch(() => [] as MessageV2.WithParts[])
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.info.role === "assistant" && (m.info as MessageV2.Assistant).summary === true) {
        return m.info.id
      }
    }
    return undefined
  }

  async function annotateAnchorWithSkillState(input: {
    sessionID: string
    summaryText: string
    prevAnchorId: string | undefined
    kind: KindName
    /** Explicit anchor id (used by tryLlmAgent which already knows it). */
    explicitAnchorId?: string
    /** compaction-fix Phase 2 (DD-8). */
    serverCompactedItems?: unknown[]
    /** compaction-fix Phase 2 (DD-9). */
    chainBinding?: { accountId: string; modelId: string; capturedAt: number }
  }): Promise<void> {
    const newAnchorId = input.explicitAnchorId ?? (await readMostRecentAnchorId(input.sessionID))
    if (!newAnchorId) {
      log.warn("compaction.anchor.skill_binding_skipped", {
        sessionID: input.sessionID,
        reason: "no anchor found after write",
      })
      return
    }

    const entries = SkillLayerRegistry.list(input.sessionID)
    const knownNames = entries.map((e) => e.name)
    const matched = SkillLayerRegistry.scanReferences(input.summaryText, knownNames)

    for (const name of matched) {
      SkillLayerRegistry.pinForAnchor(input.sessionID, name, newAnchorId, "referenced-by-anchor")
      log.info("skill.pin_for_anchor", {
        sessionID: input.sessionID,
        anchorId: newAnchorId,
        skillName: name,
        reason: "referenced-by-anchor",
      })
    }

    let unpinnedNames: string[] = []
    if (input.prevAnchorId && input.prevAnchorId !== newAnchorId) {
      unpinnedNames = SkillLayerRegistry.unpinByAnchor(input.sessionID, input.prevAnchorId)
      if (unpinnedNames.length > 0) {
        log.info("skill.unpin_by_anchor", {
          sessionID: input.sessionID,
          anchorId: input.prevAnchorId,
          unpinnedNames,
        })
      }
    }

    // DD-9 (Phase B): skillSnapshot persisted on the anchor's compaction part
    // metadata so audit + replay can read it from disk. Telemetry log retained
    // as backup signal.
    const snapshot = {
      active: entries.filter((e) => e.runtimeState === "active" || e.runtimeState === "sticky").map((e) => e.name),
      summarized: entries.filter((e) => e.runtimeState === "summarized").map((e) => e.name),
      pinned: entries.filter((e) => e.pinned).map((e) => e.name),
    }
    log.info("compaction.anchor.skill_snapshot", {
      sessionID: input.sessionID,
      anchorId: newAnchorId,
      kind: input.kind,
      matchedReferences: matched,
      releasedFromPrevAnchor: unpinnedNames,
      snapshot,
    })

    // Persist on the anchor's compaction part. Find the part by walking
    // the anchor message; if missing, log and continue (telemetry-only path
    // still preserves the data).
    try {
      const anchorMsg = (await Session.messages({ sessionID: input.sessionID })).find((m) => m.info.id === newAnchorId)
      const compactionPart = anchorMsg?.parts.find(
        (p) => p.type === "compaction" || p.type === "compaction-request",
      ) as MessageV2.CompactionPart | undefined
      if (!compactionPart) {
        log.warn("compaction.anchor.skill_snapshot_persist_skipped", {
          sessionID: input.sessionID,
          anchorId: newAnchorId,
          reason: "no compaction part on anchor",
        })
        return
      }
      await Session.updatePart({
        id: compactionPart.id,
        messageID: newAnchorId,
        sessionID: input.sessionID,
        type: compactionPart.type,
        auto: compactionPart.auto,
        metadata: {
          skillSnapshot: snapshot,
          pinnedByAnchor: matched,
          // compaction-fix Phase 2 (DD-8/DD-9): persist server-compacted
          // ResponseItem[] + chain identity binding when low-cost-server
          // produced them. Skipped (undefined) for narrative/replay-tail/
          // llm-agent kinds which only contribute summaryText.
          ...(input.serverCompactedItems ? { serverCompactedItems: input.serverCompactedItems } : {}),
          ...(input.chainBinding ? { chainBinding: input.chainBinding } : {}),
        },
      } as MessageV2.CompactionPart)
    } catch (err) {
      log.warn("compaction.anchor.skill_snapshot_persist_failed", {
        sessionID: input.sessionID,
        anchorId: newAnchorId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
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
    setReplayHelper(fn: typeof replayUnansweredUserMessage) {
      _replayHelper = fn
    },
    resetReplayHelper() {
      _replayHelper = replayUnansweredUserMessage
    },
    tryLocalRedactedDialog,
    extractAnchorTextBody,
    runCodexServerSideRecompress,
    scheduleHybridEnrichment,
    /**
     * Test seam (2026-05-13 amend): exposes shouldInjectContinue so the
     * specs/compaction/user-msg-replay-unification rev2 + specs/session/
     * rebind-procedure-revision rev4 amend's chain-init-pending override
     * can be unit-tested directly.
     */
    shouldInjectContinue,
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

  // ───────────────────────────────────────────────────────────────────
  // compaction_simplification T1: new strategy taxonomy + unified Anchor
  // shape. Pure additive in this commit — readers / writers still use
  // legacy AnchorKind / Hybrid.AnchorMetadata until T2-T9 land.
  // See plans/compaction_simplification/design.md §1 INV-1, §3.
  // ───────────────────────────────────────────────────────────────────

  /**
   * Strategy classification axis: who executes the compaction.
   * `local`    — deterministic code in this process; 0 product LLM tokens
   * `ai_free`  — provider's server-side endpoint (codex / Claude server-side)
   * `ai_paid`  — this product's paid LLM call
   * See plans/compaction_simplification/design.md §1 INV-1.
   */
  export type CompactionStrategy = "local" | "ai_free" | "ai_paid"

  /**
   * One entry in the chained tool recall index (T1 forward-compat shape).
   * Allows the anchor to reference past tool calls by id without retaining
   * their payload. Inherited generation-to-generation under `local`
   * strategy. See plans/compaction_simplification/design.md §3, §5.
   */
  export interface ToolRecallEntry {
    toolCallId: string
    toolName: string
    roundIndex: number
  }

  /**
   * Workspace snapshot embedded inside the anchor (subsumes the legacy
   * `shared_context/<sessionID>` storage key). Populated by batch
   * extraction over the message range covered by the anchor. See
   * plans/compaction_simplification/design.md §6.
   */
  export interface AnchorWorkspaceFile {
    path: string
    lines?: number
    summary?: string
    operation: "read" | "edit" | "write" | "grep_match" | "glob_match"
    updatedAt: number
  }
  export interface AnchorWorkspaceAction {
    tool: string
    summary: string
    turn: number
    addedAt: number
  }
  export interface AnchorWorkspace {
    goal: string
    files: AnchorWorkspaceFile[]
    discoveries: string[]
    actions: AnchorWorkspaceAction[]
    currentState: string
  }

  /**
   * Unified Anchor value (T1 shape). The compaction subsystem's sole
   * durable output. Subsumes the legacy `Hybrid.AnchorMetadata`,
   * `SharedContext.Space`, `Hybrid.JournalEntry`, and `PinnedZoneEntry`
   * surfaces. On-disk shape remains the assistant `summary: true`
   * message; this value lives in that message's metadata block.
   *
   * Pure additive in T1 — production writers still emit
   * `Hybrid.AnchorMetadata`. T2-T9 migrate writers and readers.
   *
   * See plans/compaction_simplification/design.md §3.
   */
  export interface Anchor {
    // Identity
    sessionID: string
    anchorId: string
    version: 1
    generatedAt: number
    replacesAnchorId?: string

    // Strategy classification (INV-1)
    strategy: CompactionStrategy
    generatedBy?: {
      provider: string
      model: string
      accountId: string
    }

    // Body + coverage
    body: string
    bodyTokens: number
    coversRounds: { earliest: number; latest: number }
    priorAnchorTokens: number
    tailTokens: number

    // Local-only chained recall index (payload-free).
    toolRecallIndex?: ToolRecallEntry[]

    // Workspace snapshot (subsumes SharedContext.Space).
    workspace: AnchorWorkspace

    // Upgrade lifecycle for local → ai_paid background promotion
    // (replaces legacy 5K hybrid_llm threshold; T4 will gate at 20%).
    upgrade?: {
      eligibleAt: number
      scheduledAt?: number
      completedAt?: number
      fromStrategy?: "local"
      failureReason?: string
    }
  }

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
      // compaction/recall-affordance L1: pre-compute TOOL_INDEX from
      // priorAnchor (carries forward) + journalUnpinned (current cycle's
      // tool calls). Deterministic — the LLM's job is just to preserve
      // the section verbatim at the end of the body.
      const priorIndex = ToolIndex.parseFromBody(request.priorAnchor?.content ?? "")
      const freshIndex = ToolIndex.extractFromJournal(request.journalUnpinned as any[])
      const merged = ToolIndex.merge(priorIndex, freshIndex)
      // INV-6: budget the index at ~10% of targetTokens worth of bytes
      // (4 chars/token rule-of-thumb). Truncates oldest entries first.
      const budgetBytes = Math.max(2_000, Math.floor((request.targetTokens / 10) * 4))
      const { entries: budgeted } = ToolIndex.applyBudget(merged, budgetBytes)
      const renderedIndex = ToolIndex.renderSection(budgeted)

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
      // compaction/recall-affordance L1: append the verbatim-preserve
      // instruction with the precomputed TOOL_INDEX section.
      lines.push(ToolIndex.buildPromptInstruction(renderedIndex))
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
          provider: ctx.model.providerId ?? ctx.userMessage.model?.providerId ?? "unknown",
          model: ctx.model.id ?? ctx.userMessage.model?.modelID ?? "unknown",
        })

        if (isLast) {
          // T7 lineage: only the final chunk lands as a persisted anchor
          // (intermediate chunks are throwaway stubs cleaned up below).
          const prevAnchorId = (await Memory.Hybrid.getAnchorMessage(sessionID).catch(() => null))?.info.id
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
            replacesAnchorId: prevAnchorId,
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
        /**
         * user-msg-replay-unification DD-5 / DD-10: thread observed
         * through so the finally-block records it in recentEvents
         * instead of "unknown". Optional; defaults to "manual" for
         * direct callers that don't set it.
         */
        observed?: Observed
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
        void publishCompactedAndResetChain(sessionID, {
          observed: opts.observed ?? "manual",
          kind: "ai_paid",
        })
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
      //
      // 2026-05-12 (Phase C of session/rebind-procedure-revision):
      // intentionally kept as direct invalidateContinuationFamily, NOT
      // routed through Continuation.run. This site is a pre-flight
      // scrub — the AI hasn't seen any compaction-related context yet,
      // so writing a pendingContinuationInjection here would either
      // (a) fire chain_init_notice on the compaction LLM call (wrong:
      // the compaction agent is a sub-process that doesn't need it)
      // or (b) get immediately overwritten by the runLlmCompact finally
      // block (3595) which calls publishCompactedAndResetChain →
      // Continuation.run with the correct post-compaction semantics.
      try {
        const { invalidateContinuationFamily } = await import("@opencode-ai/provider-codex/continuation")
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
          : userMessage.model
            ? await Provider.getModel(userMessage.model.providerId, userMessage.model.modelID)
            : await Provider.getModel(...(await Provider.defaultModel().then((m) => [m.providerId, m.modelID] as const)))
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
      const accountId = agentModel?.accountId ?? exec?.accountId ?? userMessage.model?.accountId

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
        provider: model.providerId ?? userMessage.model?.providerId ?? "unknown",
        model: model.id ?? userMessage.model?.modelID ?? "unknown",
      })

      // Stub assistant message in the stream — becomes the anchor when
      // validation passes. If validation fails we still leave the message
      // (it has the failed body) and the caller may either delete it or
      // overwrite on retry. For simplicity in this initial cut we leave
      // it; a follow-up will clean up failed-attempt anchors.
      // T7 lineage:
      const prevAnchorId = (await Memory.Hybrid.getAnchorMessage(sessionID).catch(() => null))?.info.id
      const stub = (await Session.updateMessage({
        id: Identifier.ascending("message"),
        role: "assistant",
        parentID,
        sessionID,
        mode: "compaction",
        agent: "compaction",
        variant: userMessage.variant,
        summary: true,
        replacesAnchorId: prevAnchorId,
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
        /**
         * user-msg-replay-unification DD-5 / DD-10: caller observed
         * value, threaded into runLlmCompact so its publish records
         * the right `observed` in recentEvents.
         */
        observed?: Observed
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
      const first = await runLlmCompact(sessionID, request, {
        abort: opts.abort,
        busMode: opts.busMode,
        observed: opts.observed,
      })
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
          observed: opts.observed,
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
        const phase2 = await runLlmCompact(sessionID, phase2Request, {
          abort: opts.abort,
          busMode: opts.busMode,
          observed: opts.observed,
        })
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
