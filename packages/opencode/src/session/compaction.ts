import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Session } from "."
import { Identifier } from "../id/id"
import { Instance } from "../project/instance"
import { Provider } from "../provider/provider"
import { MessageV2 } from "./message-v2"
import { Global } from "../global"
import z from "zod"
import path from "path"
import fs from "fs/promises"
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
import { ContinuationInvalidatedEvent } from "../plugin/codex-auth"

const SessionDeletedEvent = BusEvent.define(
  "session.deleted",
  z.object({
    info: z.object({
      id: Identifier.schema("session"),
    }),
  }),
)

// Subscribe to continuation invalidation: schedule compaction for next round
Bus.subscribe(ContinuationInvalidatedEvent, (evt) => {
  SessionCompaction.markRebindCompaction(evt.properties.sessionId)
})

Bus.subscribe(SessionDeletedEvent, (evt) => {
  void SessionCompaction.deleteRebindCheckpoint(evt.properties.info.id)
})

setTimeout(() => {
  void SessionCompaction.pruneStaleCheckpoints()
}, 5000)

export namespace SessionCompaction {
  const log = Log.create({ service: "session.compaction" })

  // Per-session flag: set when server rejects previous_response_id.
  // Next round's pre-flight check should force compaction to minimize
  // full-context rebind cost.
  const _pendingRebindCompaction = new Set<string>()

  // Default cooldown for rebind compaction (rounds). Mirrors the by-request
  // cooldown used by isOverflow/shouldCacheAwareCompact. Without this gate, a
  // misfiring continuation-invalidation signal can re-trigger rebind compaction
  // every round (event_2026-04-27_runloop_rebind_loop).
  const REBIND_COOLDOWN_ROUNDS = 4

  export function markRebindCompaction(sessionID: string) {
    _pendingRebindCompaction.add(sessionID)
    log.warn("continuation invalidated, compaction scheduled for next round", { sessionID })
  }

  /**
   * Returns true if the pending rebind flag is set AND we're past the
   * per-session compaction cooldown. Caller should treat a true return as
   * "go ahead and compact now"; the flag is consumed only on success. If
   * cooldown blocks the consume, the flag stays pending so a later round
   * (post-cooldown) can still honor it.
   */
  export function consumeRebindCompaction(sessionID: string, currentRound?: number): boolean {
    if (!_pendingRebindCompaction.has(sessionID)) return false
    if (currentRound !== undefined) {
      const state = cooldownState.get(sessionID)
      if (state && currentRound - state.lastCompactionRound < REBIND_COOLDOWN_ROUNDS) {
        log.info("rebind compaction skipped (cooldown)", {
          sessionID,
          roundsSince: currentRound - state.lastCompactionRound,
          cooldownRounds: REBIND_COOLDOWN_ROUNDS,
        })
        return false
      }
    }
    _pendingRebindCompaction.delete(sessionID)
    return true
  }

  // ── Rebind Checkpoint ──
  // Quietly snapshots compacted context to disk for restart recovery.
  // Does NOT touch the live message chain — cache stays intact.
  // On rebind (restart + previous_response_not_found), the checkpoint
  // is used as the input base instead of rebuilding from all messages.

  const REBIND_BUDGET_TOKEN_THRESHOLD = 80_000
  const REBIND_CHECKPOINT_MAX_AGE_MS = 24 * 60 * 60 * 1000
  const _lastCheckpointRound = new Map<string, number>()

  export interface RebindCheckpoint {
    sessionID: string
    timestamp: number
    source: string
    snapshot: string
    lastMessageId: string
    opaqueItems?: unknown[]
  }

  function getRebindCheckpointPath(sessionID: string) {
    return path.join(Global.Path.state, `rebind-checkpoint-${sessionID}.json`)
  }

  export function shouldRebindBudgetCompact(input: {
    tokens: MessageV2.Assistant["tokens"]
    sessionID: string
    currentRound: number
  }): boolean {
    const count =
      input.tokens.total ||
      input.tokens.input + input.tokens.output + input.tokens.cache.read + input.tokens.cache.write
    if (count < REBIND_BUDGET_TOKEN_THRESHOLD) return false

    // Cooldown: don't checkpoint every single round
    const lastRound = _lastCheckpointRound.get(input.sessionID) ?? 0
    if (input.currentRound - lastRound < 4) return false

    return true
  }

  export async function saveRebindCheckpoint(input: {
    sessionID: string
    lastMessageId?: string
    currentRound: number
  }) {
    try {
      const snap = await SharedContext.snapshot(input.sessionID)
      if (!snap || !input.lastMessageId) return

      _lastCheckpointRound.set(input.sessionID, input.currentRound)

      await saveCheckpointAfterCompaction({
        sessionID: input.sessionID,
        source: "llm",
        summary: snap,
        lastMessageId: input.lastMessageId,
      })
    } catch (e) {
      log.warn("rebind checkpoint save failed", { sessionID: input.sessionID, error: String(e) })
    }
  }

  /**
   * Unified checkpoint save — called by BOTH A (codex-server) and B (LLM) compaction paths.
   * Non-blocking when called as fire-and-forget.
   */
  export async function saveCheckpointAfterCompaction(input: {
    sessionID: string
    source: string
    summary: string
    lastMessageId: string
    opaqueItems?: unknown[]
  }) {
    try {
      const checkpointPath = getRebindCheckpointPath(input.sessionID)
      const checkpoint: RebindCheckpoint = {
        sessionID: input.sessionID,
        timestamp: Date.now(),
        source: input.source,
        snapshot: input.summary,
        lastMessageId: input.lastMessageId,
        opaqueItems: input.opaqueItems,
      }
      await fs.mkdir(path.dirname(checkpointPath), { recursive: true })
      const tmpPath = `${checkpointPath}.tmp`
      await fs.writeFile(tmpPath, JSON.stringify(checkpoint))
      await fs.rename(tmpPath, checkpointPath)
      log.info("checkpoint saved after compaction", {
        sessionID: input.sessionID,
        source: input.source,
        bytes: input.summary.length,
        lastMessageId: input.lastMessageId,
        opaqueItemCount: input.opaqueItems?.length,
      })
    } catch (e) {
      log.warn("checkpoint save after compaction failed", { sessionID: input.sessionID, error: String(e) })
    }
  }

  export async function loadRebindCheckpoint(sessionID: string): Promise<RebindCheckpoint | null> {
    try {
      const checkpointPath = getRebindCheckpointPath(sessionID)
      const content = await fs.readFile(checkpointPath, "utf-8")
      const checkpoint = JSON.parse(content) as RebindCheckpoint
      log.info("rebind checkpoint loaded", { sessionID, age: Date.now() - checkpoint.timestamp })
      return checkpoint
    } catch {
      return null
    }
  }

  export async function deleteRebindCheckpoint(sessionID: string) {
    try {
      await fs.unlink(getRebindCheckpointPath(sessionID))
      log.info("rebind checkpoint deleted", { sessionID })
    } catch {}
  }

  export async function pruneStaleCheckpoints(now = Date.now()) {
    try {
      const files = await fs.readdir(Global.Path.state)
      for (const file of files) {
        if (!file.startsWith("rebind-checkpoint-") || !file.endsWith(".json")) continue
        const filePath = path.join(Global.Path.state, file)
        const stat = await fs.stat(filePath)
        if (now - stat.mtimeMs <= REBIND_CHECKPOINT_MAX_AGE_MS) continue
        await fs.unlink(filePath)
        log.info("pruned stale rebind checkpoint", { file, age: now - stat.mtimeMs })
      }
    } catch (e) {
      log.warn("failed to prune stale checkpoints", { error: String(e) })
    }
  }

  export function applyRebindCheckpoint(input: {
    sessionID: string
    checkpoint: RebindCheckpoint
    messages: MessageV2.WithParts[]
    model: Provider.Model
  }):
    | { applied: false; reason: "boundary_missing" | "unsafe_boundary" | "no_post_boundary" }
    | { applied: true; messages: MessageV2.WithParts[] } {
    const boundaryIndex = input.messages.findIndex((message) => message.info.id === input.checkpoint.lastMessageId)
    if (boundaryIndex === -1) return { applied: false, reason: "boundary_missing" }

    const postBoundary = input.messages.slice(boundaryIndex + 1)
    if (postBoundary.length === 0) return { applied: false, reason: "no_post_boundary" }

    const firstPost = postBoundary[0]
    const unsafeBoundary =
      firstPost.info.role === "assistant" &&
      firstPost.parts.some((part) => part.type === "tool" && part.state.status !== "pending")
    if (unsafeBoundary) return { applied: false, reason: "unsafe_boundary" }

    const summaryMessageID = Identifier.ascending("message")
    const syntheticSummary: MessageV2.WithParts = {
      info: {
        id: summaryMessageID,
        sessionID: input.sessionID,
        role: "assistant",
        parentID: input.checkpoint.lastMessageId,
        mode: "rebind",
        agent: "rebind-checkpoint",
        modelID: input.model.id,
        providerId: input.model.providerId,
        accountId: undefined,
        path: { cwd: Instance.directory, root: Instance.worktree },
        summary: true,
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        finish: "stop",
        time: { created: input.checkpoint.timestamp, completed: input.checkpoint.timestamp },
      },
      parts: [
        {
          id: Identifier.ascending("part"),
          messageID: summaryMessageID,
          sessionID: input.sessionID,
          type: "text",
          text: input.checkpoint.snapshot,
          synthetic: true,
        },
      ],
    }

    return { applied: true, messages: [syntheticSummary, ...postBoundary] }
  }

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

  // Per-session cooldown tracking to prevent compaction oscillation
  const cooldownState = new Map<string, { lastCompactionRound: number }>()

  export function recordCompaction(sessionID: string, round: number) {
    cooldownState.set(sessionID, { lastCompactionRound: round })
  }

  export function getCooldownState(sessionID: string) {
    return cooldownState.get(sessionID)
  }

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

    const usable = input.model.limit.input
      ? input.model.limit.input - reserved
      : context -
        ProviderTransform.maxOutputTokens(
          input.model.providerId,
          {},
          input.model.limit.output || 32_000,
          SessionPrompt.OUTPUT_TOKEN_MAX,
        )

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

    // Cooldown check: skip compaction if too soon after last one
    if (input.sessionID && input.currentRound !== undefined) {
      const state = cooldownState.get(input.sessionID)
      if (state) {
        const roundsSince = input.currentRound - state.lastCompactionRound
        if (roundsSince < budget.cooldownRounds) {
          log.info("compaction skipped (cooldown)", {
            sessionID: input.sessionID,
            roundsSince,
            cooldownRounds: budget.cooldownRounds,
          })
          return false
        }
      }
    }

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

    // Respect cooldown
    if (input.sessionID && input.currentRound !== undefined) {
      const state = cooldownState.get(input.sessionID)
      if (state) {
        const roundsSince = input.currentRound - state.lastCompactionRound
        if (roundsSince < budget.cooldownRounds) {
          log.info("cache-aware compaction skipped (cooldown)", {
            sessionID: input.sessionID,
            cacheHitRate: (cacheHitRate * 100).toFixed(0) + "%",
            utilization: (utilization * 100).toFixed(0) + "%",
            roundsSince,
          })
          return false
        }
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

  export const PRUNE_MINIMUM = 20_000
  export const PRUNE_PROTECT = 40_000

  const PRUNE_PROTECTED_TOOLS = ["skill"]

  // goes backwards through parts until there are 40_000 tokens worth of tool
  // calls. then erases output of previous tool calls. idea is to throw away old
  // tool calls that are no longer relevant.
  export async function prune(input: { sessionID: string }) {
    const config = await Config.get()
    if (config.compaction?.prune === false) return
    log.info("pruning")
    const msgs = await Session.messages({ sessionID: input.sessionID })
    let total = 0
    let pruned = 0
    const toPrune = []
    let turns = 0

    loop: for (let msgIndex = msgs.length - 1; msgIndex >= 0; msgIndex--) {
      const msg = msgs[msgIndex]
      if (msg.info.role === "user") turns++
      if (turns < 2) continue
      if (msg.info.role === "assistant" && msg.info.summary) break loop
      for (let partIndex = msg.parts.length - 1; partIndex >= 0; partIndex--) {
        const part = msg.parts[partIndex]
        if (part.type === "tool")
          if (part.state.status === "completed") {
            if (PRUNE_PROTECTED_TOOLS.includes(part.tool)) continue

            if (part.state.time.compacted) break loop
            const estimate = Token.estimate(part.state.output)
            total += estimate
            if (total > PRUNE_PROTECT) {
              pruned += estimate
              toPrune.push(part)
            }
          }
      }
    }
    log.info("found", { pruned, total })
    if (pruned > PRUNE_MINIMUM) {
      for (const part of toPrune) {
        if (part.state.status === "completed") {
          part.state.time.compacted = Date.now()
          await Session.updatePart(part)
        }
      }
      log.info("pruned", { count: toPrune.length })
    }
  }

  export async function process(input: {
    parentID: string
    messages: MessageV2.WithParts[]
    sessionID: string
    abort: AbortSignal
    auto: boolean
  }) {
    const userMessage = input.messages.findLast((m) => m.info.id === input.parentID)!.info as MessageV2.User

    // Announce compaction start immediately so the UI can show a toast even
    // during the slow plugin round-trip (Codex /responses/compact can take
    // 30s+). The Compacted event at the tail still fires on completion.
    Bus.publish(Event.CompactionStarted, { sessionID: input.sessionID, mode: "plugin" })

    // --- Plugin-provided server compaction (e.g. Codex /responses/compact) ---
    const serverResult = await tryPluginCompaction(input, userMessage)
    if (serverResult) return serverResult

    // Plugin path bailed — we're falling through to LLM compaction.
    Bus.publish(Event.CompactionStarted, { sessionID: input.sessionID, mode: "llm" })

    // --- LEAGCY RESTORATION: Always trigger true Summary for others (like Gemini) ---
    const agent = await Agent.get("compaction")
    log.info("triggering TRUE Summary Compaction (Legacy Agent)", { sessionID: input.sessionID })
    const model = agent.model
      ? await Provider.getModel(agent.model.providerId, agent.model.modelID)
      : await Provider.getModel(userMessage.model.providerId, userMessage.model.modelID)

    // T5.2: Skip B (LLM compaction) if model cannot meaningfully summarize
    if (!canSummarize(model)) {
      log.warn("skipping LLM compaction: model context too small for meaningful summary (D fallback)", {
        sessionID: input.sessionID,
        modelID: model.id,
        contextLimit: model.limit?.context,
      })
      return "stop"
    }
    const agentModel = agent.model as { accountId?: string } | undefined
    // Read session's pinned execution identity so compaction inherits the
    // account the user was actually using, not the global-active fallback.
    // Without this, compaction resolves to global-active and then the
    // processor pins that account onto the session — silently overwriting
    // the user's chosen account.
    const session = await Session.get(input.sessionID)
    const accountId = agentModel?.accountId ?? userMessage.model.accountId ?? session?.execution?.accountId
    const msg = (await Session.updateMessage({
      id: Identifier.ascending("message"),
      role: "assistant",
      parentID: input.parentID,
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
      modelID: model.id,
      providerId: model.providerId,
      accountId,
      time: {
        created: Date.now(),
      },
    })) as MessageV2.Assistant
    const processor = SessionProcessor.create({
      assistantMessage: msg,
      sessionID: input.sessionID,
      model,
      accountId,
      abort: input.abort,
    })
    // Allow plugins to inject context or replace compaction prompt
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
      user: userMessage,
      agent,
      abort: input.abort,
      sessionID: input.sessionID,
      tools: {},
      system: [],
      messages: sanitizeOrphanedToolCalls([
        ...history.messages,
        {
          role: "user",
          content: [
            {
              type: "text",
              text: promptText,
            },
          ],
        },
      ]),
      model,
    })

    if (result === "continue" && input.auto) {
      const continueMsg = await Session.updateMessage({
        id: Identifier.ascending("message"),
        role: "user",
        sessionID: input.sessionID,
        time: {
          created: Date.now(),
        },
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
    if (processor.message.error) return "stop"

    // Write the compaction boundary anchor on the summary assistant message.
    // filterCompacted() uses this as the authoritative truncation point.
    // (Previously, create()'s "compaction-request" trigger marker was mistakenly
    // used as the boundary, but that caused premature truncation before the
    // summary was written.)
    await Session.updatePart({
      id: Identifier.ascending("part"),
      messageID: processor.message.id,
      sessionID: input.sessionID,
      type: "compaction",
      auto: input.auto,
    })

    Bus.publish(Event.Compacted, { sessionID: input.sessionID })

    // T3.3: Save checkpoint after B (LLM) compaction
    const summaryMsg = (await Session.messages({ sessionID: input.sessionID }))
      .findLast((m) => m.info.id === processor.message.id)
    const summaryText = summaryMsg?.parts
      .filter((p) => p.type === "text")
      .map((p) => (p as any).text ?? "")
      .join("\n")
    if (summaryText) {
      void saveCheckpointAfterCompaction({
        sessionID: input.sessionID,
        source: "llm",
        summary: summaryText,
        lastMessageId: input.parentID,
      })
    }

    return "continue"
  }

  /**
   * Idle compaction: triggered at turn boundary when a completed task dispatch
   * is detected and context utilization exceeds the opportunistic threshold.
   * Uses shared context snapshot as the summary instead of LLM compaction agent.
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

    const snap = await SharedContext.snapshot(input.sessionID)
    if (!snap) {
      log.info("idle compaction skipped: empty snapshot")
      return
    }

    await compactWithSharedContext({
      sessionID: input.sessionID,
      snapshot: snap,
      model: input.model,
      auto: true,
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

    // Persist checkpoint so rebind can restore from this compaction point
    void saveCheckpointAfterCompaction({
      sessionID: input.sessionID,
      source: "shared-context",
      summary: input.snapshot,
      lastMessageId: parentID,
    })

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

  /**
   * Try plugin-provided server compaction via session.compact hook.
   *
   * If a plugin (e.g. codex-provider) handles compaction server-side,
   * it returns compactedItems + summary. Core uses those as the canonical
   * next context window. If no plugin handles it, returns null → LLM fallback.
   */
  async function tryPluginCompaction(
    input: {
      parentID: string
      messages: MessageV2.WithParts[]
      sessionID: string
      abort: AbortSignal
      auto: boolean
    },
    userMessage: MessageV2.User,
  ): Promise<"continue" | "stop" | null> {
    try {
      // Build generic conversation items from messages (provider-agnostic serialization)
      const conversationItems: unknown[] = []
      for (const msg of input.messages) {
        if (msg.info.role === "user") {
          const textParts = msg.parts.filter((p) => p.type === "text")
          if (textParts.length > 0) {
            conversationItems.push({
              type: "message",
              role: "user",
              content: textParts.map((p) => ({
                type: "input_text",
                text: (p as any).text ?? "",
              })),
            })
          }
        } else if (msg.info.role === "assistant") {
          const textParts = msg.parts.filter((p) => p.type === "text")
          if (textParts.length > 0) {
            conversationItems.push({
              type: "message",
              role: "assistant",
              content: textParts.map((p) => ({
                type: "output_text",
                text: (p as any).text ?? "",
              })),
            })
          }
          for (const p of msg.parts) {
            if (p.type === "tool" && p.state.status === "completed") {
              conversationItems.push({
                type: "function_call",
                call_id: (p as any).toolCallId ?? p.id,
                name: p.tool,
                arguments:
                  typeof (p as any).input === "string" ? (p as any).input : JSON.stringify((p as any).input ?? {}),
              })
              const stateOutput = p.state.output
              if (stateOutput != null && typeof stateOutput !== "string") {
                // Fail-loud per AGENTS.md "no silent fallback": JSON.stringify
                // of a structured tool output is what poisoned Codex memory in
                // the gpt-5.5 envelope incident. Tool authors must store
                // string output; if a tool ever changes shape, surface it
                // here instead of silently sending JSON to the compactor.
                throw new Error(
                  `tryPluginCompaction: tool ${p.tool} state.output is non-string ` +
                    `(${typeof stateOutput}); add an explicit unwrap before sending to plugin compact.`,
                )
              }
              conversationItems.push({
                type: "function_call_output",
                call_id: (p as any).toolCallId ?? p.id,
                output: stateOutput ?? "",
              })
            }
          }
        }
      }

      if (conversationItems.length === 0) return null

      const agent = await Agent.get(userMessage.agent ?? "default")
      const instructions = (agent.prompt ?? "").slice(0, 50000)

      // Ask plugins if they can handle compaction server-side
      const hookResult = await Plugin.trigger(
        "session.compact",
        {
          sessionID: input.sessionID,
          model: {
            providerId: userMessage.model.providerId,
            modelID: userMessage.model.modelID,
            accountId: userMessage.model.accountId,
          },
          conversationItems,
          instructions,
        },
        { compactedItems: null as unknown[] | null, summary: null as string | null },
      )

      const compactedItems = hookResult.compactedItems
      if (!compactedItems) return null

      // Plugin provided server-compacted items — use as canonical context window
      const summaryText = hookResult.summary || "[Server-compacted conversation history]"
      const model = await Provider.getModel(userMessage.model.providerId, userMessage.model.modelID)

      await compactWithSharedContext({
        sessionID: input.sessionID,
        snapshot: summaryText,
        model,
        auto: input.auto,
      })

      log.info("plugin server compaction complete", {
        sessionID: input.sessionID,
        providerId: userMessage.model.providerId,
        outputItems: compactedItems.length,
      })

      const lastMsgId = input.messages.at(-1)?.info.id
      if (lastMsgId) {
        void saveCheckpointAfterCompaction({
          sessionID: input.sessionID,
          source: `${userMessage.model.providerId}-server`,
          summary: summaryText,
          lastMessageId: lastMsgId,
          opaqueItems: compactedItems,
        })
      }

      return "continue"
    } catch (err) {
      log.warn("plugin server compaction failed, falling back to LLM agent", { error: String(err) })
      return null
    }
  }

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
}
