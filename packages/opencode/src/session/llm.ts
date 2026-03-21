import { Installation } from "@/installation"
import { Provider } from "@/provider/provider"
import { getCapabilities, requiresDummyTool } from "@/provider/capabilities"
import { Log } from "@/util/log"
import {
  streamText,
  wrapLanguageModel,
  convertToModelMessages,
  type ModelMessage,
  type StreamTextResult,
  type Tool,
  type ToolSet,
  type UIMessage,
  tool,
  jsonSchema,
} from "ai"
import { clone, mergeDeep, pipe } from "remeda"
import { ProviderTransform } from "@/provider/transform"
import { Config } from "@/config/config"
import { Instance } from "@/project/instance"
import type { Agent } from "@/agent/agent"
import type { MessageV2 } from "./message-v2"
import { Plugin } from "@/plugin"
import { SystemPrompt } from "./system"
import { Flag } from "@/flag/flag"
import { PermissionNext } from "@/permission/next"
import { Auth } from "@/auth"
import { Token } from "@/util/token"

import z from "zod"
import { findFallback, type ModelVector, type FallbackStrategy, isVectorRateLimited } from "@/account/rotation3d"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { TuiEvent } from "@/cli/cmd/tui/event"
import { debugCheckpoint } from "@/util/debug"
import { RateLimitJudge, isRateLimitError, isAuthError, formatRateLimitReason } from "@/account/rate-limit-judge"

import { RequestMonitor } from "@/account/monitor"
import ENABLEMENT from "./prompt/enablement.json"
import { logSessionAccountAudit, resolveAccountAuditSource } from "./account-audit"

/**
 * Bus event for real-time LLM error reporting to the webapp sidebar.
 * Fires for EVERY error in onError — not just rate limits.
 */
export const LlmErrorEvent = BusEvent.define(
  "llm.error",
  z.object({
    providerId: z.string(),
    modelId: z.string(),
    accountId: z.string(),
    sessionID: z.string(),
    status: z.number().optional(),
    message: z.string(),
    timestamp: z.number(),
  }),
)

/**
 * Bus event for rotation chain tracking.
 * Fires every time a fallback rotation executes (from → to).
 */
export const RotationExecutedEvent = BusEvent.define(
  "rotation.executed",
  z.object({
    fromProviderId: z.string(),
    fromModelId: z.string(),
    fromAccountId: z.string(),
    toProviderId: z.string(),
    toModelId: z.string(),
    toAccountId: z.string(),
    reason: z.string(),
    timestamp: z.number(),
  }),
)

export const PromptTelemetryEvent = BusEvent.define(
  "llm.prompt.telemetry",
  z.object({
    sessionID: z.string(),
    promptId: z.string(),
    providerId: z.string(),
    modelId: z.string(),
    accountId: z.string().optional(),
    finalSystemTokens: z.number(),
    finalSystemChars: z.number(),
    finalSystemMessages: z.number(),
    messageCount: z.number(),
    blocks: z.array(
      z.object({
        key: z.string(),
        chars: z.number(),
        tokens: z.number(),
        injected: z.boolean(),
        policy: z.string(),
      }),
    ),
    timestamp: z.number(),
  }),
)

export namespace LLM {
  const log = Log.create({ service: "llm" })

  export const OUTPUT_TOKEN_MAX = Flag.OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX || 32_000

  // Toast debouncing for rate-limit and rotation notifications
  const TOAST_DEBOUNCE_MS = 15_000

  let lastRateLimitToastAt = 0
  let lastRotationToastAt = 0

  export type StreamInput = {
    user: MessageV2.User
    sessionID: string
    model: Provider.Model
    accountId?: string
    agent: Agent.Info
    system: string[]
    abort: AbortSignal
    messages: ModelMessage[]
    small?: boolean
    tools: Record<string, Tool>
    toolChoice?: "auto" | "required" | "none"
    retries?: number
  }

  export type StreamOutput = StreamTextResult<ToolSet, unknown>

  async function isSubagentSession(sessionID: string): Promise<boolean> {
    const { Session: SessionMod } = await import("@/session")
    const info = await SessionMod.get(sessionID)
    return !!info?.parentID
  }

  function extractLatestUserText(messages: ModelMessage[]): string {
    const user = [...messages].reverse().find((m) => m.role === "user")
    if (!user) return ""
    const content = user.content
    if (typeof content === "string") return content.toLowerCase()
    if (!Array.isArray(content)) return ""
    return content
      .map((part: any) => {
        if (!part || typeof part !== "object") return ""
        if (typeof part.text === "string") return part.text
        if (typeof part.input === "string") return part.input
        return ""
      })
      .join("\n")
      .toLowerCase()
  }

  function getMatchedIntents(messages: ModelMessage[]): string[] {
    const data = ENABLEMENT as any
    const text = extractLatestUserText(messages)
    return ((data?.routing?.intent_to_capability ?? []) as any[])
      .filter((route) => (route?.keywords ?? []).some((kw: string) => text.includes(String(kw).toLowerCase())))
      .slice(0, 4)
      .map((route) => route.intent)
  }

  function shouldInjectEnablementSnapshot(messages: ModelMessage[]) {
    if (messages.length <= 1) return true
    return getMatchedIntents(messages).length > 0
  }

  function buildEnablementSnapshot(messages: ModelMessage[]): string {
    const data = ENABLEMENT as any
    const coreTools = (data?.tools?.core ?? []).map((x: any) => x.name).slice(0, 12)
    const skills = (data?.skills?.bundled_templates ?? []).slice(0, 20)
    const mcpServers = (data?.mcp_servers?.runtime_observed ?? []).map(
      (x: any) => `${x.name}:${x.enabled ? "on" : "off"}`,
    )
    const matchedIntents = getMatchedIntents(messages)

    return [
      "[ENABLEMENT SNAPSHOT]",
      `- source: prompts/enablement.json`,
      `- core tools: ${coreTools.join(", ")}`,
      `- skills available: ${skills.join(", ")}`,
      `- configured mcp: ${mcpServers.join(", ")}`,
      `- matched intents: ${matchedIntents.length ? matchedIntents.join("; ") : "none"}`,
      `- policy: prefer registry-guided tool/skill/mcp routing; use on-demand mcp when needed`,
    ].join("\n")
  }

  export async function stream(input: StreamInput) {
    debugCheckpoint("llm", "LLM.stream started", {
      modelID: input.model.id,
      providerId: input.model.providerId,
      apiNpm: input.model.api.npm,
      apiId: input.model.api.id,
      sessionID: input.sessionID,
      agent: input.agent.name,
      small: input.small ?? false,
      trace: input.sessionID,
    })

    const l = log
      .clone()
      .tag("providerId", input.model.providerId)
      .tag("modelID", input.model.id)
      .tag("sessionID", input.sessionID)
      .tag("small", (input.small ?? false).toString())
      .tag("agent", input.agent.name)
      .tag("mode", input.agent.mode)
    l.info("stream", {
      modelID: input.model.id,
      providerId: input.model.providerId,
    })
    // Get account ID for rate limit tracking and provider options
    const sessionPinnedAccountId = input.accountId ?? input.user.model.accountId
    let currentAccountId = sessionPinnedAccountId ?? (await getAccountIdForProvider(input.model.providerId))

    // Pre-flight: if resolved account is rate-limited, proactively select a healthy one
    if (currentAccountId && !sessionPinnedAccountId) {
      const { getRateLimitTracker, getHealthTracker } = await import("@/account/rotation")
      const rateLimitTracker = getRateLimitTracker()
      if (rateLimitTracker.isRateLimited(currentAccountId, input.model.providerId, input.model.id)) {
        const { Account } = await import("@/account")
        const providerKey = input.model.providerId
        const accounts = await Account.list(providerKey).catch(() => ({}))
        const healthTracker = getHealthTracker()
        // Find first healthy, non-rate-limited account for same provider
        let bestAccountId: string | undefined
        let bestScore = -1
        for (const [accId] of Object.entries(accounts)) {
          if (accId === currentAccountId) continue
          if (rateLimitTracker.isRateLimited(accId, providerKey, input.model.id)) continue
          const score = healthTracker.getScore(accId, providerKey)
          if (score < 50) continue
          if (score > bestScore) {
            bestScore = score
            bestAccountId = accId
          }
        }
        if (bestAccountId) {
          l.info("pre-flight: swapped rate-limited account", {
            from: currentAccountId,
            to: bestAccountId,
            providerId: providerKey,
            modelID: input.model.id,
          })
          currentAccountId = bestAccountId
        }
      }
    }

    if (!input.accountId && currentAccountId) {
      input.accountId = currentAccountId
    }
    // CHECKPOINT: ivon0829 tracker
    if (currentAccountId && currentAccountId.includes("ivon0829")) {
      debugCheckpoint("syslog.ivon0829", "⚠ ivon0829 resolved in LLM.stream", {
        sessionID: input.sessionID,
        providerId: input.model.providerId,
        modelID: input.model.id,
        accountId: currentAccountId,
        source: sessionPinnedAccountId ? "session-pinned" : "global-active",
        inputAccountId: input.accountId,
        userMessageAccountId: input.user.model.accountId,
        stack: new Error().stack,
      })
    }

    if (!sessionPinnedAccountId && currentAccountId) {
      debugCheckpoint("llm", "LLM.stream fell back to global active account", {
        providerId: input.model.providerId,
        modelID: input.model.id,
        accountId: currentAccountId,
        sessionID: input.sessionID,
      })
    }
    logSessionAccountAudit({
      requestPhase: "llm-start",
      sessionID: input.sessionID,
      userMessageID: input.user.id,
      providerId: input.model.providerId,
      modelID: input.model.id,
      accountId: currentAccountId,
      source: resolveAccountAuditSource({
        explicitAccountId: input.accountId,
        userMessageAccountId: input.user.model.accountId,
        resolvedAccountId: currentAccountId,
      }),
      note: "llm stream starting with resolved execution identity",
    })

    const executionModel = await Provider.resolveExecutionModel({
      model: input.model,
      accountId: currentAccountId,
    })

    const [language, cfg, provider, auth] = await Promise.all([
      Provider.getLanguage(executionModel),
      Config.get(),
      Provider.getProvider(executionModel.providerId),
      Auth.get(executionModel.providerId),
    ])

    debugCheckpoint("llm", "Provider and auth loaded", {
      providerId: input.model.providerId,
      executionProviderId: executionModel.providerId,
      providerSource: provider?.source,
      hasCustomFetch: typeof provider?.options?.fetch === "function",
      accountId: currentAccountId,
      authType: auth?.type,
      providerOptionsKeys: provider?.options ? Object.keys(provider.options) : [],
      trace: input.sessionID,
    })

    // Get provider capabilities (centralizes provider-specific behavior)
    const capabilities = getCapabilities(provider, auth)
    // Legacy alias for gradual migration - these will be removed once all usages migrate to capabilities
    const usesInstructions = capabilities.useInstructionsOption

    const subagentSession = await isSubagentSession(input.sessionID)
    const injectEnablementSnapshot = shouldInjectEnablementSnapshot(input.messages)
    const system = []
    const systemPartEntries = [
      {
        key: "provider_prompt",
        policy: usesInstructions ? "conditional" : "always_on",
        text: usesInstructions ? "" : (await SystemPrompt.provider(input.model)).join("\n"),
      },
      {
        key: "agent_prompt",
        policy: "conditional",
        text: input.agent.prompt ?? "",
      },
      {
        key: "dynamic_system",
        policy: "dynamic",
        text: input.system.join("\n"),
      },
      {
        key: "enablement_snapshot",
        policy: injectEnablementSnapshot ? "conditional_active" : "conditional_skipped",
        text: injectEnablementSnapshot ? buildEnablementSnapshot(input.messages) : "",
      },
      {
        key: "user_system",
        policy: "conditional",
        text: input.user.system ?? "",
      },
      {
        key: "critical_boundary_separator",
        policy: "always_on",
        text: `\n\n--- CRITICAL OPERATIONAL BOUNDARY ---\n\n`,
      },
      {
        key: "core_system_prompt",
        policy: "always_on",
        text: (await SystemPrompt.system(subagentSession)).join("\n"),
      },
      {
        key: "identity_reinforcement",
        policy: "always_on",
        text:
          `\n\n[IDENTITY REINFORCEMENT]\n` +
          `Current Role: ${subagentSession ? "Subagent" : "Main Agent"}\n` +
          `Session Context: ${subagentSession ? "Sub-task" : "Main-task Orchestration"}`,
      },
    ]

    system.push(
      systemPartEntries
        .map((entry) => entry.text)
        .filter((x) => x)
        .join("\n"),
    )

    // 7. Model-specific prompt optimization (inline, no hook indirection)
    // Gemini models respond better when AGENTS.md instructions are
    // wrapped in <behavioral_guidelines> XML tags with restructured ordering.
    const modelId = input.model?.id?.toLowerCase() || ""
    if (modelId.includes("gemini") && system[0]) {
      const mainPrompt = system[0]
      const agentsBlockRegex = /Instructions from: .*?AGENTS\.md[\s\S]*?(?=\nInstructions from:|<env>|$)/g
      const matches = mainPrompt.match(agentsBlockRegex)
      if (matches && matches.length > 0) {
        const agentsContent = matches.join("\n\n").trim()
        let strippedPrompt = mainPrompt.replace(agentsBlockRegex, "").trim()
        const headerRegex = /^(IMPORTANT:[\s\S]*?)(?=\n# |$)/
        const headerMatch = strippedPrompt.match(headerRegex)
        let header = ""
        if (headerMatch) {
          header = headerMatch[1].trim()
          strippedPrompt = strippedPrompt.replace(headerMatch[0], "").trim()
        }
        const optimizedAgents = `<behavioral_guidelines>\n${agentsContent}\n</behavioral_guidelines>`
        system[0] = [header, optimizedAgents, strippedPrompt].filter(Boolean).join("\n\n")
      }
    }

    const header = system[0]
    const original = clone(system)
    await Plugin.trigger(
      "experimental.chat.system.transform",
      { sessionID: input.sessionID, model: input.model },
      { system },
    )
    if (system.length === 0) {
      system.push(...original)
    }
    // rejoin to maintain 2-part structure for caching if header unchanged
    if (system.length > 2 && system[0] === header) {
      const rest = system.slice(1)
      system.length = 0
      system.push(header, rest.join("\n"))
    }

    const variant =
      !input.small && input.model.variants && input.user.variant ? input.model.variants[input.user.variant] : {}
    const base = input.small
      ? ProviderTransform.smallOptions(input.model, provider.options)
      : ProviderTransform.options({
          model: input.model,
          sessionID: input.sessionID,
          providerOptions: provider.options,
          accountId: currentAccountId,
        })
    const options: Record<string, any> = pipe(
      base,
      mergeDeep(input.model.options),
      mergeDeep(input.agent.options),
      mergeDeep(variant),
    )
    if (usesInstructions) {
      options.instructions = await SystemPrompt.instructions()
    }

    const params = await Plugin.trigger(
      "chat.params",
      {
        sessionID: input.sessionID,
        agent: input.agent,
        model: input.model,
        provider,
        message: input.user,
      },
      {
        temperature: input.model.capabilities.temperature
          ? (input.agent.temperature ?? ProviderTransform.temperature(input.model))
          : undefined,
        topP: input.agent.topP ?? ProviderTransform.topP(input.model),
        topK: ProviderTransform.topK(input.model),
        options,
      },
    )

    const { headers } = await Plugin.trigger(
      "chat.headers",
      {
        sessionID: input.sessionID,
        agent: input.agent,
        model: input.model,
        provider,
        message: input.user,
      },
      {
        headers: {},
      },
    )

    const maxOutputTokens = capabilities.skipMaxOutputTokens
      ? undefined
      : ProviderTransform.maxOutputTokens(
          input.model.api.npm,
          params.options,
          input.model.limit.output,
          OUTPUT_TOKEN_MAX,
        )

    const tools = await resolveTools(input)

    // LiteLLM and some Anthropic proxies require the tools parameter to be present
    // when message history contains tool calls, even if no tools are being used.
    // Add a dummy tool that is never called to satisfy this validation.
    // This is enabled for:
    // 1. Providers with "litellm" in their ID or API ID (auto-detected)
    // 2. Providers with explicit "litellmProxy: true" option (opt-in for custom gateways)
    const isLiteLLMProxy =
      provider.options?.["litellmProxy"] === true ||
      input.model.providerId.toLowerCase().includes("litellm") ||
      input.model.api.id.toLowerCase().includes("litellm")

    if (isLiteLLMProxy && Object.keys(tools).length === 0 && hasToolCalls(input.messages)) {
      tools["_noop"] = tool({
        description:
          "Placeholder for LiteLLM/Anthropic proxy compatibility - required when message history contains tool calls but no active tools are needed",
        inputSchema: jsonSchema({ type: "object", properties: {} }),
        execute: async () => ({ output: "", title: "", metadata: {} }),
      })
    }

    // FIX: Filter out empty system messages to prevent Anthropic API rejection
    // Anthropic API returns 400 error: "system: text content blocks must be non-empty"
    // @event_20260209_empty_system_blocks
    const filteredSystem = system.filter((x) => x && x.trim() !== "")
    const promptTelemetryBlocks = systemPartEntries.map((entry) => ({
      key: entry.key,
      chars: entry.text.length,
      tokens: Token.estimate(entry.text),
      injected: entry.text.trim().length > 0,
      policy: entry.policy,
    }))
    const finalSystemChars = filteredSystem.reduce((sum, item) => sum + item.length, 0)
    const finalSystemTokens = filteredSystem.reduce((sum, item) => sum + Token.estimate(item), 0)
    const promptId = `prompt_${Bun.hash(
      JSON.stringify({
        sessionID: input.sessionID,
        providerId: input.model.providerId,
        modelId: input.model.id,
        accountId: currentAccountId,
        messageCount: input.messages.length,
        blocks: promptTelemetryBlocks,
        finalSystemChars,
        finalSystemTokens,
      }),
    ).toString(36)}`

    Bus.publish(PromptTelemetryEvent, {
      sessionID: input.sessionID,
      promptId,
      providerId: input.model.providerId,
      modelId: input.model.id,
      accountId: currentAccountId,
      finalSystemTokens,
      finalSystemChars,
      finalSystemMessages: filteredSystem.length,
      messageCount: input.messages.length,
      blocks: promptTelemetryBlocks,
      timestamp: Date.now(),
    }).catch(() => {})

    const systemMessages =
      capabilities.systemMessageRole === "user"
        ? ([
            {
              role: "user",
              content: filteredSystem.join("\n\n"),
            },
          ] as ModelMessage[])
        : filteredSystem.map(
            (x): ModelMessage => ({
              role: "system",
              content: x,
            }),
          )

    const streamMessages = [...systemMessages, ...input.messages]

    const finalMessages = normalizeMessages(streamMessages, tools)

    // Get account ID for rate limit tracking
    const accountId = currentAccountId
    const requestProviderOptions = ProviderTransform.providerOptions(input.model, params.options)

    const serializeError = (err: unknown): unknown => {
      if (!(err instanceof Error)) return err
      const base: Record<string, unknown> = {
        name: err.name,
        message: err.message,
        stack: err.stack,
      }
      const withCause = err as Error & { cause?: unknown; issues?: unknown }
      if (withCause.cause !== undefined) base.cause = serializeError(withCause.cause)
      if (withCause.issues !== undefined) base.issues = withCause.issues
      return base
    }

    const serializeErrorForDebug = (err: unknown): Record<string, unknown> => {
      const baseError = serializeError(err)
      const obj = err && typeof err === "object" ? (err as Record<string, unknown>) : undefined
      const data = obj?.data && typeof obj.data === "object" ? (obj.data as Record<string, unknown>) : undefined
      return {
        error: baseError,
        status: obj?.status ?? obj?.statusCode ?? data?.status,
        code: obj?.code ?? data?.code,
        name: obj?.name,
        message: (() => {
          const raw = obj?.message ?? data?.message
          if (raw == null) return undefined
          return typeof raw === "string" ? raw : JSON.stringify(raw)
        })(),
        responseHeaders: data?.responseHeaders,
        responseBody: data?.responseBody,
        headers: obj?.headers ?? data?.headers,
        errorType:
          data?.error && typeof data.error === "object" ? (data.error as Record<string, unknown>).type : undefined,
        data,
      }
    }

    return streamText({
      onFinish: async (event) => {
        const usage = event.usage as any
        const totalTokens = usage
          ? (usage.promptTokens || usage.inputTokens || 0) + (usage.completionTokens || usage.outputTokens || 0)
          : 0
        RequestMonitor.get().recordRequest(input.model.providerId, accountId || "unknown", input.model.id, totalTokens)
      },
      async onError(error) {
        l.error("stream error", { error: serializeError(error) })

        debugCheckpoint("rotation.error", "LLM onError received provider error", {
          providerId: input.model.providerId,
          modelID: input.model.id,
          accountId,
          sessionID: input.sessionID,
          errorDetail: serializeErrorForDebug(error),
        })

        // Publish raw error to webapp sidebar — fires for ALL errors
        {
          const details = serializeErrorForDebug(error)
          const status = typeof details.status === "number" ? details.status : undefined
          const msg =
            typeof details.message === "string"
              ? details.message
              : error instanceof Error
                ? error.message
                : typeof error === "object" && error !== null
                  ? JSON.stringify(error)
                  : String(error)
          Bus.publish(LlmErrorEvent, {
            providerId: input.model.providerId,
            modelId: input.model.id,
            accountId: accountId || "unknown",
            sessionID: input.sessionID,
            status,
            message: msg.length > 300 ? msg.slice(0, 300) + "…" : msg,
            timestamp: Date.now(),
          }).catch(() => {})
        }

        if (!accountId) return

        // @event_20260216_rate_limit_judge: Delegate all classification to RateLimitJudge
        // Judge handles: error classification, backoff calculation, provider-specific strategy,
        // tracker updates, and Bus event broadcasting — all in one call.

        if (isAuthError(error)) {
          await RateLimitJudge.recordAuthFailure(input.model.providerId, accountId, input.model.id, error)

          // Show persistent error toast
          Bus.publish(TuiEvent.ToastShow, {
            title: "Authentication Failed",
            message: `Auth failed for ${accountId}. Please re-authenticate.`,
            variant: "error",
            duration: 15000,
          }).catch(() => {})
          return
        }

        if (isRateLimitError(error)) {
          const result = await RateLimitJudge.judge(input.model.providerId, accountId, input.model.id, error)

          // Publish toast notification (debounced)
          const now = Date.now()
          if (now - lastRateLimitToastAt >= TOAST_DEBOUNCE_MS) {
            lastRateLimitToastAt = now
            const waitMinutes = Math.ceil(result.backoffMs / 60000)
            const reasonText = formatRateLimitReason(result.reason)
            Bus.publish(TuiEvent.ToastShow, {
              title: "Rate Limit",
              message: `${input.model.id}: ${reasonText}. Cooling down for ${waitMinutes}m.`,
              variant: "warning",
              duration: 8000,
            }).catch(() => {})
          }
        }
      },
      async experimental_repairToolCall(failed) {
        const lower = failed.toolCall.toolName.toLowerCase()
        if (lower !== failed.toolCall.toolName && tools[lower]) {
          l.info("repairing tool call", {
            tool: failed.toolCall.toolName,
            repaired: lower,
          })
          return {
            ...failed.toolCall,
            toolName: lower,
          }
        }
        return {
          ...failed.toolCall,
          input: JSON.stringify({
            tool: failed.toolCall.toolName,
            error: failed.error.message,
          }),
          toolName: "invalid",
        }
      },
      temperature: params.temperature,
      topP: params.topP,
      topK: params.topK,
      providerOptions: requestProviderOptions,
      activeTools: Object.keys(tools).filter((x) => x !== "invalid"),
      tools,
      toolChoice: input.toolChoice,
      maxOutputTokens,
      abortSignal: input.abort,
      headers: {
        ...(accountId ? { "x-opencode-account-id": accountId } : {}),
        ...(input.model.providerId.startsWith("opencode")
          ? {
              "x-opencode-project": Instance.project.id,
              "x-opencode-session": input.sessionID,
              "x-opencode-request": input.user.id,
              "x-opencode-client": Flag.OPENCODE_CLIENT,
            }
          : input.model.providerId !== "claude-cli"
            ? {
                "User-Agent": `opencode/${Installation.VERSION}`,
              }
            : undefined),
        ...input.model.headers,
        ...headers,
      },
      maxRetries: input.retries ?? 0,
      messages: finalMessages,
      model: wrapLanguageModel({
        model: language,
        middleware: [
          {
            async transformParams(args) {
              if (args.type === "stream") {
                const params = args.params as { messages?: ModelMessage[]; prompt?: ModelMessage[] }
                const prompt = Array.isArray(params.messages) ? params.messages : params.prompt
                if (!Array.isArray(prompt)) return args.params
                const next = ProviderTransform.message(prompt as ModelMessage[], input.model, options)
                if (Array.isArray(params.messages)) {
                  params.messages = next
                  return args.params
                }
                params.prompt = next
              }
              return args.params
            },
          },
        ],
      }),
      experimental_telemetry: {
        isEnabled: cfg.experimental?.openTelemetry,
        metadata: {
          userId: cfg.username ?? "unknown",
          sessionId: input.sessionID,
        },
      },
    })
  }

  async function resolveTools(input: Pick<StreamInput, "tools" | "agent" | "user">) {
    const disabled = PermissionNext.disabled(Object.keys(input.tools), input.agent.permission)
    for (const tool of Object.keys(input.tools)) {
      if (input.user.tools?.[tool] === false || disabled.has(tool)) {
        delete input.tools[tool]
      }
    }
    return input.tools
  }

  // Check if messages contain any tool-call content
  // Used to determine if a dummy tool should be added for LiteLLM proxy compatibility
  export function hasToolCalls(messages: ModelMessage[]): boolean {
    for (const msg of messages) {
      if (!Array.isArray(msg.content)) continue
      for (const part of msg.content) {
        if (part.type === "tool-call" || part.type === "tool-result") return true
      }
    }
    return false
  }

  function normalizeMessages(messages: Array<ModelMessage | UIMessage>, tools: Record<string, Tool>): ModelMessage[] {
    if (messages.length === 0) return []
    const list: ModelMessage[] = []
    for (const msg of messages) {
      if (isUIMessage(msg)) {
        const converted = convertToModelMessages([msg], { tools: tools as ToolSet })
        list.push(...converted)
        continue
      }
      list.push(msg)
    }
    return list
  }

  function isUIMessage(msg: ModelMessage | UIMessage): msg is UIMessage {
    return typeof msg === "object" && msg !== null && "parts" in msg
  }

  /**
   * Get the active account ID for a provider.
   * Used for rate limit tracking.
   */
  async function getAccountIdForProvider(providerId: string): Promise<string | undefined> {
    const { Account } = await import("@/account")

    // Resolve canonical provider key from provider ID
    const resolveProviderKey = (Account as any).resolveProvider ?? (Account as any).resolveFamily
    const providerKey = await resolveProviderKey(providerId)
    if (!providerKey) return undefined

    // Get active account
    return Account.getActive(providerKey)
  }

  /**
   * Record a successful request for the current provider.
   * Call this after a stream completes successfully.
   *
   * @event_20260216_rate_limit_judge: Delegates to RateLimitJudge.recordSuccess
   * which clears rate limits, updates health, and broadcasts Cleared event.
   */
  export async function recordSuccess(providerId: string, modelID?: string, accountId?: string): Promise<void> {
    log.info("recordSuccess called", { providerId, modelID, accountId })
    debugCheckpoint("health", "llm.recordSuccess", { providerId, modelID, accountId })

    const resolvedAccountId = accountId ?? (await getAccountIdForProvider(providerId))
    if (resolvedAccountId && modelID) {
      await RateLimitJudge.recordSuccess(providerId, resolvedAccountId, modelID)
    } else if (resolvedAccountId) {
      // Fallback: if no modelID, use the old path
      const { Account } = await import("@/account")
      await Account.recordSuccess(resolvedAccountId, providerId)
    }
  }

  const PURPOSE_LABELS: Record<string, string> = {
    coding: "擅長程式開發",
    reasoning: "擅長邏輯推理",
    image: "支援圖片處理",
    docs: "擅長文件分析",
    "long-context": "支援長文本",
    audio: "支援音訊處理",
    video: "支援影片處理",
    "rate-limit": "頻率限制",
  }

  /**
   * Check if rate limit handling is needed for a provider.
   * Returns the next available model if rotation is possible.
   *
   * Uses the 3D rotation system to find the best fallback across
   * (provider, account, model) dimensions.
   *
   * @param currentModel - The model that hit rate limit
   * @param strategy - Fallback selection strategy
   * @param triedVectors - Set of already-tried "provider:account:model" keys to avoid infinite loops
   * @param error - Optional error object that triggered the fallback
   */
  export async function handleRateLimitFallback(
    currentModel: Provider.Model,
    strategy: FallbackStrategy = "account-first",
    triedVectors: Set<string> = new Set(),
    error?: unknown,
    currentAccountIdInput?: string,
    sessionIdentity?: { providerId: string; accountId?: string },
  ): Promise<{ model: Provider.Model; accountId?: string } | null> {
    const { Account } = await import("@/account")

    const resolveProviderKey = (Account as any).resolveProvider ?? (Account as any).resolveFamily
    const providerKey = await resolveProviderKey(currentModel.providerId)
    if (!providerKey) return null

    // Get current account
    const currentAccountId = currentAccountIdInput ?? (await Account.getActive(providerKey))
    if (!currentAccountId) return null

    // Build current vector key and add to tried set
    const currentVectorKey = `${currentModel.providerId}:${currentAccountId}:${currentModel.id}`
    triedVectors.add(currentVectorKey)

    // @event_20260216_rate_limit_judge: Delegate marking to RateLimitJudge
    // This replaces ~160 lines of inline cockpit queries, RPD inference, and tracker updates
    await RateLimitJudge.markRateLimited(currentModel.providerId, currentAccountId, currentModel.id, error)

    // Build current vector
    const currentVector: ModelVector = {
      providerId: currentModel.providerId,
      accountId: currentAccountId,
      modelID: currentModel.id,
    }

    // Use 3D rotation to find best fallback
    // Same-provider account rotation is guarded by SameProviderRotationGuard
    // (max once per cooldown). Cross-provider rotation is unrestricted.
    let fallback = await findFallback(currentVector, { strategy, allowSameProviderFallback: true }, triedVectors)

    // SYSLOG: Log findFallback result
    debugCheckpoint("syslog.rotation", "handleRateLimitFallback: findFallback returned", {
      currentVector: `${currentModel.providerId}:${currentAccountId}:${currentModel.id}`,
      fallbackResult: fallback
        ? `${fallback.providerId}:${fallback.accountId}:${fallback.modelID} (reason=${fallback.reason})`
        : "null",
      strategy,
      triedVectorCount: triedVectors.size,
      triedVectors: Array.from(triedVectors),
    })

    if (!fallback) {
      debugCheckpoint("syslog.rotation", "handleRateLimitFallback: no fallback candidate found", {
        currentVector: `${currentModel.providerId}:${currentAccountId}:${currentModel.id}`,
        strategy,
        triedVectorCount: triedVectors.size,
        note: "all candidates exhausted or rate-limited",
      })
      return null
    }

    // FIX: Enforce session identity constraint — when a session has pinned
    // provider/account, rotation must NOT escape to a different provider or
    // account. This prevents subagent account drift during rate-limit rotation.
    //
    // Allow cross-provider and cross-account fallback.
    // rotation3d.ts already filters candidates to only include enabled providers
    // with active accounts. The previous identity filter blocked these valid
    // candidates, causing stuck sessions when all same-provider accounts
    // were rate-limited.
    if (fallback.providerId !== currentModel.providerId || fallback.accountId !== currentAccountId) {
      debugCheckpoint("syslog.rotation", "Cross-provider/account fallback selected", {
        fromProviderId: currentModel.providerId,
        fromAccountId: currentAccountId,
        fromModelID: currentModel.id,
        toProviderId: fallback.providerId,
        toAccountId: fallback.accountId,
        toModelID: fallback.modelID,
      })
    }

    // Add the selected fallback to tried vectors to avoid immediate retry in subsequent attempts
    const fallbackKey = `${fallback.providerId}:${fallback.accountId}:${fallback.modelID}`

    // Check if this fallback has already been tried (should be caught by findFallback, but as a safeguard)
    if (triedVectors.has(fallbackKey)) {
      log.warn("Fallback already tried after selection", {
        fallback: fallbackKey,
        triedCount: triedVectors.size,
      })
      return null
    }

    // Mark as tried
    triedVectors.add(fallbackKey)

    // Log the dimension change
    const isSameProvider = fallback.providerId === currentModel.providerId
    const isSameAccount = fallback.accountId === currentAccountId
    const isSameModel = fallback.modelID === currentModel.id

    const fallbackReason = isVectorRateLimited(currentVector) ? "rate-limit" : "unknown"
    const purposeValue = (fallback as unknown as Record<string, unknown>).purpose
    const purpose = typeof purposeValue === "string" ? purposeValue : fallbackReason
    const reasonLabel = PURPOSE_LABELS[purpose] || fallback.reason

    // Extract error label from error object or fallback to reason label
    let errorLabel = `(${reasonLabel})`
    if (error) {
      const errorObject = error && typeof error === "object" ? (error as Record<string, any>) : undefined
      const data =
        errorObject?.data && typeof errorObject.data === "object"
          ? (errorObject.data as Record<string, any>)
          : undefined
      const status = errorObject?.status ?? errorObject?.statusCode ?? data?.status
      const message = errorObject?.message ?? data?.message ?? String(error)
      errorLabel = `(${status ?? "Error"})${message}`
    }

    const sanitizedErrorLabel = errorLabel.replace(/\s*Retry later or choose another model\.?/gi, "").trim()

    const fromAcc = Account.getShortId(currentAccountId, currentModel.providerId)
    const toAcc = Account.getShortId(fallback.accountId, fallback.providerId)

    const fromStr = `${currentModel.providerId},${currentModel.id},${fromAcc}`
    const toStr = `${fallback.providerId},${fallback.modelID},${toAcc}`
    const toastMsg = `${sanitizedErrorLabel}\n${fromStr}->\n${toStr}`

    log.info("3D fallback selected", {
      reason: fallback.reason,
      trigger: fallbackReason,
      changes: {
        provider: !isSameProvider,
        account: !isSameAccount,
        model: !isSameModel,
      },
      from: fromStr,
      to: toStr,
    })

    debugCheckpoint("rotation3d", "Executing fallback switch", {
      trigger: fallbackReason,
      strategy: fallback.reason,
      from: fromStr,
      to: toStr,
      changes: {
        provider: !isSameProvider,
        account: !isSameAccount,
        model: !isSameModel,
      },
    })

    // Publish rotation event for LLM status card history chain
    Bus.publish(RotationExecutedEvent, {
      fromProviderId: currentModel.providerId,
      fromModelId: currentModel.id,
      fromAccountId: currentAccountId,
      toProviderId: fallback.providerId,
      toModelId: fallback.modelID,
      toAccountId: fallback.accountId,
      reason: fallbackReason === "rate-limit" ? "RATE_LIMIT_EXCEEDED" : "UNKNOWN",
      timestamp: Date.now(),
    }).catch(() => {})

    if (isSameProvider && (!isSameAccount || !isSameModel)) {
      const { getSameProviderRotationGuard, SAME_PROVIDER_ROTATE_COOLDOWN_MS } = await import("@/account/rotation")
      getSameProviderRotationGuard().mark(
        currentModel.providerId,
        currentAccountId,
        fallback.accountId,
        fallback.modelID,
        SAME_PROVIDER_ROTATE_COOLDOWN_MS,
      )
      debugCheckpoint("rotation3d", "Same-provider rotate guard armed", {
        providerId: currentModel.providerId,
        fromAccountId: currentAccountId,
        toAccountId: fallback.accountId,
        modelID: fallback.modelID,
        waitMs: SAME_PROVIDER_ROTATE_COOLDOWN_MS,
      })
    }

    // If same model but different account, keep the model object and return a
    // session-local account override instead of mutating global active account.
    if (isSameModel && !isSameAccount && isSameProvider) {
      // Notify user of account rotation (debounced)
      const now1 = Date.now()
      if (now1 - lastRotationToastAt >= TOAST_DEBOUNCE_MS) {
        lastRotationToastAt = now1
        Bus.publish(TuiEvent.ToastShow, {
          message: toastMsg,
          variant: "info",
          duration: 8000,
        }).catch(() => {})
      }

      // Return currentModel here, as the rotation only changed the account.
      return { model: currentModel, accountId: fallback.accountId }
    }

    // If different model or provider, get the full model info
    const fallbackModel = await Provider.getModel(fallback.providerId, fallback.modelID)
    if (!fallbackModel) {
      log.warn("Fallback model not found", {
        providerId: fallback.providerId,
        modelID: fallback.modelID,
      })
      // If fallback model info can't be found, add it to tried and search again
      triedVectors.add(fallbackKey)
      return handleRateLimitFallback(currentModel, strategy, triedVectors, error, currentAccountId)
    }

    // Notify user of model/provider rotation (debounced)
    const now2 = Date.now()
    if (now2 - lastRotationToastAt >= TOAST_DEBOUNCE_MS) {
      lastRotationToastAt = now2
      Bus.publish(TuiEvent.ToastShow, {
        message: toastMsg,
        variant: "info",
        duration: 8000,
      }).catch(() => {})
    }

    return { model: fallbackModel, accountId: fallback.accountId }
  }

  // formatRateLimitReason moved to @/account/rate-limit-judge.ts
}
