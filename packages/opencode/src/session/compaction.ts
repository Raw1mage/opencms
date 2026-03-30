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
import { codexServerCompact } from "../provider/codex-compaction"
import { ContinuationInvalidatedEvent } from "../plugin/codex"

// Subscribe to continuation invalidation: schedule compaction for next round
Bus.subscribe(ContinuationInvalidatedEvent, (evt) => {
  SessionCompaction.markRebindCompaction(evt.properties.sessionId)
})

export namespace SessionCompaction {
  const log = Log.create({ service: "session.compaction" })

  // Per-session flag: set when server rejects previous_response_id.
  // Next round's pre-flight check should force compaction to minimize
  // full-context rebind cost.
  const _pendingRebindCompaction = new Set<string>()

  export function markRebindCompaction(sessionID: string) {
    _pendingRebindCompaction.add(sessionID)
    log.warn("continuation invalidated, compaction scheduled for next round", { sessionID })
  }

  export function consumeRebindCompaction(sessionID: string): boolean {
    return _pendingRebindCompaction.delete(sessionID)
  }

  export const Event = {
    Compacted: BusEvent.define(
      "session.compacted",
      z.object({
        sessionID: z.string(),
      }),
    ),
  }

  const COMPACTION_BUFFER = 20_000
  const DEFAULT_HEADROOM = 8_000
  const DEFAULT_COOLDOWN_ROUNDS = 8
  const EMERGENCY_CEILING = 2_000

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
      cooldownRounds: config.compaction?.cooldownRounds ?? (byToken ? BY_TOKEN_COOLDOWN_ROUNDS : DEFAULT_COOLDOWN_ROUNDS),
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

    // --- Server-side compaction for codex provider (Phase 4) ---
    if (userMessage.model.providerId === "codex") {
      const serverResult = await tryServerCompaction(input, userMessage)
      if (serverResult) return serverResult
      log.info("codex server compaction unavailable, falling back to LLM agent")
    }

    const agent = await Agent.get("compaction")
    const model = agent.model
      ? await Provider.getModel(agent.model.providerId, agent.model.modelID)
      : await Provider.getModel(userMessage.model.providerId, userMessage.model.modelID)
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
      messages: [
        ...MessageV2.toModelMessages(input.messages, model),
        {
          role: "user",
          content: [
            {
              type: "text",
              text: promptText,
            },
          ],
        },
      ],
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
    Bus.publish(Event.Compacted, { sessionID: input.sessionID })
    return "continue"
  }

  /**
   * Idle compaction: triggered at turn boundary when a completed task dispatch
   * is detected and context utilization exceeds the opportunistic threshold.
   * Uses shared context snapshot as the summary instead of LLM compaction agent.
   */
  export async function idleCompaction(input: {
    sessionID: string
    model: Provider.Model
    config: Config.Info
  }) {
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

    // Write the shared context snapshot as the summary text part
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

    log.info("shared context compaction complete", { sessionID: input.sessionID })
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

  /**
   * Try server-side compaction via Codex /responses/compact endpoint.
   *
   * Sends CompactionInput { model, input, instructions, tools, parallel_tool_calls }
   * and receives { output: ResponseItem[] }. The output is opaque and must not be
   * pruned — it IS the canonical next context window.
   *
   * Returns "continue" on success, null if server compaction is unavailable.
   */
  async function tryServerCompaction(
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
      // Build Responses API input items from conversation messages
      const conversationInput: unknown[] = []
      for (const msg of input.messages) {
        if (msg.info.role === "user") {
          const textParts = msg.parts.filter((p) => p.type === "text")
          if (textParts.length > 0) {
            conversationInput.push({
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
            conversationInput.push({
              type: "message",
              role: "assistant",
              content: textParts.map((p) => ({
                type: "output_text",
                text: (p as any).text ?? "",
              })),
            })
          }
          // Include tool calls and outputs
          for (const p of msg.parts) {
            if (p.type === "tool" && p.state.status === "completed") {
              conversationInput.push({
                type: "function_call",
                call_id: (p as any).toolCallId ?? p.id,
                name: p.tool,
                arguments: typeof (p as any).input === "string" ? (p as any).input : JSON.stringify((p as any).input ?? {}),
              })
              conversationInput.push({
                type: "function_call_output",
                call_id: (p as any).toolCallId ?? p.id,
                output: typeof p.state.output === "string" ? p.state.output : JSON.stringify(p.state.output ?? ""),
              })
            }
          }
        }
      }

      if (conversationInput.length === 0) return null

      // Build tool specs for compaction (server needs tools to produce correct output)
      const model = await Provider.getModel(userMessage.model.providerId, userMessage.model.modelID)
      const agent = await Agent.get(userMessage.agent ?? "default")
      // Instructions: use system prompts that the session was using
      const instructions = (agent.prompt ?? "").slice(0, 50000)

      const result = await codexServerCompact({
        model: userMessage.model.modelID,
        input: conversationInput,
        instructions,
        tools: [], // tools are not strictly required for compaction
        parallel_tool_calls: true,
      })

      if (!result.success || !result.output) return null

      // Server compaction succeeded.
      // Per API spec: "Do not prune /responses/compact output. The returned
      // window is the canonical next context window."
      // Extract readable text for the summary marker (best-effort, not authoritative)
      const summaryText = result.output
        .filter((item: any) => item.type === "message")
        .flatMap((item: any) => (item.content ?? []).map((c: any) => c.text ?? ""))
        .join("\n")
        || "[Server-compacted conversation history]"

      await compactWithSharedContext({
        sessionID: input.sessionID,
        snapshot: summaryText,
        model,
        auto: input.auto,
      })

      log.info("codex server compaction complete", {
        sessionID: input.sessionID,
        outputItems: result.output.length,
      })

      return "continue"
    } catch (err) {
      log.warn("codex server compaction failed", { error: String(err) })
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
        type: "compaction",
        auto: input.auto,
      })
    },
  )
}
