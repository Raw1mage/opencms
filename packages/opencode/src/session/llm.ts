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
import {
  isRateLimitError,
  isAuthError,
  extractRateLimitDetails,
  calculateBackoffMs,
  getHealthTracker,
  getRateLimitTracker,
  type RateLimitReason,
} from "@/account/rotation"
import {
  findFallback,
  type ModelVector,
  type FallbackStrategy,
  isVectorRateLimited,
  type RotationPurpose,
} from "@/account/rotation3d"
import { Bus } from "@/bus"
import { TuiEvent } from "@/cli/cmd/tui/event"
import { debugCheckpoint } from "@/util/debug"
import type { OAuthAuthDetails, PluginClient } from "@/plugin/antigravity/plugin/types"

import { RequestMonitor } from "@/account/monitor"

export namespace LLM {
  const log = Log.create({ service: "llm" })

  export const OUTPUT_TOKEN_MAX = Flag.OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX || 32_000

  // Toast debouncing for rate-limit and rotation notifications
  const TOAST_DEBOUNCE_MS = 15_000
  const MODEL_CAPACITY_MIN_BACKOFF_MS = 300_000
  let lastRateLimitToastAt = 0
  let lastRotationToastAt = 0

  export type StreamInput = {
    user: MessageV2.User
    sessionID: string
    model: Provider.Model
    agent: Agent.Info
    system: string[]
    abort: AbortSignal
    messages: ModelMessage[]
    small?: boolean
    tools: Record<string, Tool>
    retries?: number
  }

  export type StreamOutput = StreamTextResult<ToolSet, unknown>

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
    const currentAccountId = await getAccountIdForProvider(input.model.providerId)

    const [language, cfg, provider, auth] = await Promise.all([
      Provider.getLanguage(input.model),
      Config.get(),
      Provider.getProvider(input.model.providerId),
      Auth.get(input.model.providerId),
    ])

    debugCheckpoint("llm", "Provider and auth loaded", {
      providerId: input.model.providerId,
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

    const system = []
    system.push(
      [
        // use agent prompt if available
        ...(input.agent.prompt ? [input.agent.prompt] : []),
        // For providers using instructions option, skip SystemPrompt.provider() since it's sent via options.instructions
        ...(usesInstructions ? [] : SystemPrompt.provider(input.model)),
        // any custom prompt passed into this call
        ...input.system,
        // any custom prompt from last user message
        ...(input.user.system ? [input.user.system] : []),
      ]
        .filter((x) => x)
        .join("\n"),
    )

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
      options.instructions = SystemPrompt.instructions()
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

    return streamText({
      onFinish: async (event) => {
        const usage = event.usage as any
        const totalTokens = usage
          ? (usage.promptTokens || usage.inputTokens || 0) + (usage.completionTokens || usage.outputTokens || 0)
          : 0
        RequestMonitor.get().recordRequest(input.model.providerId, accountId || "unknown", input.model.id, totalTokens)
      },
      async onError(error) {
        l.error("stream error", {
          error: error instanceof Error ? { message: error.message, stack: error.stack, name: error.name } : error,
        })

        // Handle Authentication Errors (Hard Stop)
        if (isAuthError(error)) {
          l.error("Authentication error detected", {
            accountId,
            providerId: input.model.providerId,
            modelID: input.model.id,
          })

          if (accountId) {
            const { Account } = await import("@/account")
            await Account.recordFailure(accountId, input.model.providerId)

            const { getRateLimitTracker } = await import("@/account/rotation")
            const rateLimitTracker = getRateLimitTracker()

            // 2. Hard block for 1 hour to prevent retries
            rateLimitTracker.markRateLimited(
              accountId,
              input.model.providerId,
              "AUTH_FAILED",
              3_600_000, // 1 hour
              input.model.id,
            )
          }

          // Show persistent error toast
          Bus.publish(TuiEvent.ToastShow, {
            title: "Authentication Failed",
            message: `Auth failed for ${accountId}. Please re-authenticate.`,
            variant: "error",
            duration: 15000,
          }).catch(() => {})

          return // Stop processing
        }

        // @event_2026-02-06:rotation_unify
        // Track rate limits with account dimension for proper cross-process sharing
        // Removed ModelHealthRegistry (global) - use RateLimitTracker (per-account) only
        if (isRateLimitError(error)) {
          const { reason, retryAfterMs } = extractRateLimitDetails(error)
          const consecutiveFailures = accountId
            ? getHealthTracker().getConsecutiveFailures(accountId, input.model.providerId)
            : 0
          let backoffMs = calculateBackoffMs(reason, consecutiveFailures, retryAfterMs)

          // @event_user_request: antigravity rate limit check
          // For Antigravity, fetch real reset time from cockpit instead of guessing.
          // This prevents unnecessary hopping when the cooldown is actually short, or ensures we wait long enough.
          if (
            input.model.providerId === "antigravity" &&
            accountId &&
            reason !== "TOKEN_REFRESH_FAILED" // Trust the 5h backoff for token errors
          ) {
            try {
              const { Account } = await import("@/account")
              const { getCockpitBackoffMs } = await import("@/plugin/antigravity/plugin/quota")
              const { refreshAccessToken } = await import("@/plugin/antigravity/plugin/token")
              const { formatRefreshParts } = await import("@/plugin/antigravity/plugin/auth")

              // Get account info to build auth details
              const info = await Account.get("antigravity", accountId)
              if (info && info.type === "subscription") {
                let auth: OAuthAuthDetails = {
                  type: "oauth",
                  refresh: formatRefreshParts({
                    refreshToken: info.refreshToken,
                    projectId: info.projectId,
                    managedProjectId: info.managedProjectId,
                  }),
                  access: info.accessToken,
                  expires: info.expiresAt,
                }

                // Refresh token if needed
                if (!auth.access || !auth.expires || Date.now() >= auth.expires - 300000) {
                  const noopClient = {
                    auth: {
                      set: async () => true,
                    },
                  } as unknown as PluginClient
                  const refreshed = await refreshAccessToken(auth, noopClient, "antigravity")
                  if (refreshed) {
                    auth = refreshed
                    // Determine project ID from refreshed token or existing info
                    // We need a project ID for the cockpit call
                    const pId = info.projectId || info.managedProjectId
                    if (pId && auth.access) {
                      const result = await getCockpitBackoffMs(auth.access, pId, input.model.id, backoffMs)
                      if (result.fromCockpit) {
                        backoffMs = result.backoffMs
                        l.info("Updated rate limit backoff from cockpit", {
                          model: input.model.id,
                          originalBackoff: calculateBackoffMs(reason, consecutiveFailures, retryAfterMs),
                          newBackoff: backoffMs,
                          resetTimeMs: result.resetTimeMs,
                        })
                      }
                    }
                  }
                } else {
                  // Token is valid, use it directly
                  const pId = info.projectId || info.managedProjectId
                  if (pId && auth.access) {
                    const result = await getCockpitBackoffMs(auth.access, pId, input.model.id, backoffMs)
                    if (result.fromCockpit) {
                      backoffMs = result.backoffMs
                      l.info("Updated rate limit backoff from cockpit", {
                        model: input.model.id,
                        originalBackoff: calculateBackoffMs(reason, consecutiveFailures, retryAfterMs),
                        newBackoff: backoffMs,
                        resetTimeMs: result.resetTimeMs,
                      })
                    }
                  }
                }
              }
            } catch (e) {
              l.warn("Failed to fetch cockpit backoff", { error: e })
            }
          }

          // Guardrail: keep 503/529/capacity cooldown at least 5 minutes across all subagents.
          if (
            (reason === "SERVICE_UNAVAILABLE_503" ||
              reason === "SITE_OVERLOADED_529" ||
              reason === "MODEL_CAPACITY_EXHAUSTED") &&
            backoffMs < MODEL_CAPACITY_MIN_BACKOFF_MS
          ) {
            backoffMs = MODEL_CAPACITY_MIN_BACKOFF_MS
          }

          // Update account-level tracking (with account dimension)
          if (accountId) {
            const { Account } = await import("@/account")
            await Account.recordRateLimit(accountId, input.model.providerId, reason, backoffMs, input.model.id)
          }

          l.warn("Rate limit detected", {
            accountId,
            providerId: input.model.providerId,
            modelID: input.model.id,
            reason,
            backoffMs,
          })

          // Publish toast notification for rate limit (debounced)
          const now = Date.now()
          if (now - lastRateLimitToastAt >= TOAST_DEBOUNCE_MS) {
            lastRateLimitToastAt = now
            const waitMinutes = Math.ceil(backoffMs / 60000)
            const reasonText = formatRateLimitReason(reason)
            Bus.publish(TuiEvent.ToastShow, {
              title: "Rate Limit",
              message: `${input.model.id}: ${reasonText}. Cooling down for ${waitMinutes}m.`,
              variant: "warning",
              duration: 8000,
            }).catch(() => {}) // Ignore publish errors
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
      providerOptions: ProviderTransform.providerOptions(input.model, params.options),
      activeTools: Object.keys(tools).filter((x) => x !== "invalid"),
      tools,
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

    // Parse family from provider ID
    const family = Account.parseFamily(providerId)
    if (!family) return undefined

    // Get active account
    return Account.getActive(family)
  }

  /**
   * Record a successful request for the current provider.
   * Call this after a stream completes successfully.
   *
   * @event_2026-02-06:rotation_unify
   * Removed ModelHealthRegistry - use account-level tracking only
   */
  export async function recordSuccess(providerId: string, modelID?: string): Promise<void> {
    log.info("recordSuccess called", { providerId, modelID })
    debugCheckpoint("health", "llm.recordSuccess", { providerId, modelID })

    // Update account-level tracking
    const accountId = await getAccountIdForProvider(providerId)
    if (accountId) {
      const { Account } = await import("@/account")
      await Account.recordSuccess(accountId, providerId)

      // Clear rate limit for this specific account:provider:model combination
      if (modelID) {
        const { getRateLimitTracker } = await import("@/account/rotation")
        const rateLimitTracker = getRateLimitTracker()
        rateLimitTracker.clear(accountId, providerId, modelID)
      }

      log.info("Recorded success with account", { providerId, modelID, accountId })
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
  ): Promise<Provider.Model | null> {
    const { Account } = await import("@/account")
    const { getRateLimitTracker } = await import("@/account/rotation")

    const family = Account.parseFamily(currentModel.providerId)
    if (!family) return null

    // Get current account
    const currentAccountId = await Account.getActive(family)
    if (!currentAccountId) return null

    // Build current vector key and add to tried set
    const currentVectorKey = `${currentModel.providerId}:${currentAccountId}:${currentModel.id}`
    triedVectors.add(currentVectorKey)

    // Mark current vector as rate-limited to prevent bouncing back to it
    const rateLimitTracker = getRateLimitTracker()
    if (!rateLimitTracker.isRateLimited(currentAccountId, currentModel.providerId, currentModel.id)) {
      const { reason } = error ? extractRateLimitDetails(error) : { reason: "RATE_LIMIT_EXCEEDED" as RateLimitReason }

      // ONLY mark as rate-limited if it's a temporary/rate-limit error.
      // Do NOT mark as 429 if it's a permanent error like "model not found".
      // @event_20260215_fix_false_429
      const isTemporary =
        reason === "RATE_LIMIT_EXCEEDED" ||
        reason === "RATE_LIMIT_SHORT" ||
        reason === "RATE_LIMIT_LONG" ||
        reason === "QUOTA_EXHAUSTED" ||
        reason === "SERVICE_UNAVAILABLE_503" ||
        reason === "SITE_OVERLOADED_529" ||
        reason === "MODEL_CAPACITY_EXHAUSTED" ||
        reason === "SERVER_ERROR"

      if (isTemporary) {
        // Calculate dynamic backoff instead of hardcoded 5 minutes
        // We need consecutive failures to calculate backoff properly if it's exponential
        const consecutiveFailures = currentAccountId
          ? getHealthTracker().getConsecutiveFailures(currentAccountId, currentModel.providerId)
          : 0
        const backoffMs = calculateBackoffMs(reason, consecutiveFailures)

        // Apply cooldown to prevent immediate retry storms
        rateLimitTracker.markRateLimited(currentAccountId, currentModel.providerId, reason, backoffMs, currentModel.id)
        log.info("Marked current vector as rate-limited to prevent bounce-back", {
          provider: currentModel.providerId,
          account: currentAccountId,
          model: currentModel.id,
          reason,
          backoffMs,
        })
      } else {
        log.warn("Not marking as rate-limited: error is permanent", {
          provider: currentModel.providerId,
          model: currentModel.id,
          reason,
        })
      }
    }

    // Build current vector
    const currentVector: ModelVector = {
      providerId: currentModel.providerId,
      accountId: currentAccountId,
      modelID: currentModel.id,
    }

    // Use 3D rotation to find best fallback
    const fallback = await findFallback(currentVector, { strategy }, triedVectors)

    if (!fallback) {
      // If no fallback, return current tried vectors for next attempt
      return null
    }

    // Add the selected fallback to tried vectors to avoid immediate retry in subsequent attempts
    const fallbackKey = `${fallback.providerId}:${fallback.accountId}:${fallback.modelID}`

    // Check if this fallback has already been tried (should be caught by findFallback, but as a safeguard)
    if (triedVectors.has(fallbackKey)) {
      log.warn("Fallback already tried after selection, attempting to find another", {
        fallback: fallbackKey,
        triedCount: triedVectors.size,
      })
      // If it has been tried, recursively call again to find a *new* fallback
      return handleRateLimitFallback(currentModel, strategy, triedVectors, error)
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

    // If same model but different account, set the new account as active
    if (isSameModel && !isSameAccount && isSameProvider) {
      await Account.setActive(family, fallback.accountId)

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

      // Return currentModel here, as the rotation only changed the account, not the model object itself
      return currentModel
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
      return handleRateLimitFallback(currentModel, strategy, triedVectors, error)
    }

    // If different account in a different provider family, set that account active too
    if (!isSameProvider) {
      const fallbackFamily = Account.parseFamily(fallback.providerId)
      if (fallbackFamily) {
        await Account.setActive(fallbackFamily, fallback.accountId)
      }
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

    return fallbackModel
  }

  /**
   * Format rate limit reason for display in toast.
   */
  function formatRateLimitReason(reason: RateLimitReason): string {
    switch (reason) {
      case "QUOTA_EXHAUSTED":
        return "Quota exhausted"
      case "RATE_LIMIT_EXCEEDED":
        return "Rate limit exceeded"
      case "SERVICE_UNAVAILABLE_503":
        return "Service unavailable (503)"
      case "SITE_OVERLOADED_529":
        return "Site overloaded (529)"
      case "MODEL_CAPACITY_EXHAUSTED":
        return "Model at capacity"
      case "SERVER_ERROR":
        return "Server error"
      case "AUTH_FAILED":
        return "Authentication failed"
      default:
        return "Rate limited"
    }
  }
}
