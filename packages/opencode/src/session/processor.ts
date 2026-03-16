import { MessageV2 } from "./message-v2"
import { Log } from "@/util/log"
import { Identifier } from "@/id/id"
import { Session } from "."
import { Agent } from "@/agent/agent"
import { Snapshot } from "@/snapshot"
import { SessionSummary } from "./summary"
import { Bus } from "@/bus"
import { SessionRetry } from "./retry"
import { SessionStatus } from "./status"
import { Plugin } from "@/plugin"
import type { Provider } from "@/provider/provider"
import { LLM } from "./llm"
import { Config } from "@/config/config"
import { SessionCompaction } from "./compaction"
import { PermissionNext } from "@/permission/next"
import { Question } from "@/question"
import { debugCheckpoint } from "@/util/debug"
import { isRateLimitError, getRateLimitTracker } from "@/account/rotation"
import { isVectorRateLimited } from "@/account/rotation3d"
import { Global } from "@/global"
import path from "path"
import { materializeToolAttachments } from "./attachment-ownership"
import { clearPendingContinuation } from "./workflow-runner"
import { describeTaskNarration, emitSessionNarration } from "./narration"
import { logSessionAccountAudit, resolveAccountAuditSource } from "./account-audit"

export namespace SessionProcessor {
  const DOOM_LOOP_THRESHOLD = 3
  const log = Log.create({ service: "session.processor" })

  export type Info = Awaited<ReturnType<typeof create>>
  export type Result = Awaited<ReturnType<Info["process"]>>

  function isModelPermanentError(error: unknown): boolean {
    const { status, parts } = extractErrorDetails(error)
    if (!parts) return false
    if (!parts.includes("model") && !parts.includes("models/")) return false

    // Permanent errors: model not found, invalid model ID, access denied for specific model
    if (
      parts.includes("not found") ||
      parts.includes("not supported") ||
      parts.includes("invalid model id") ||
      (parts.includes("access denied") && parts.includes("model")) ||
      (parts.includes("permission denied") && parts.includes("model")) ||
      status === 404
    ) {
      return true
    }
    return false
  }

  function isModelTemporaryError(error: unknown): boolean {
    const { status, parts } = extractErrorDetails(error)
    if (!parts) return false

    // Temporary errors: rate limit, quota, server errors, auth failures (try other accounts)
    if (
      isRateLimitError(error) ||
      parts.includes("quota exceeded") ||
      parts.includes("rate limit") ||
      parts.includes("overloaded") ||
      parts.includes("server error") ||
      parts.includes("unauthorized") ||
      parts.includes("authenticatetoken") ||
      parts.includes("authentication failed") ||
      status === 401 ||
      status === 429 ||
      status === 500 ||
      status === 502 ||
      status === 503 ||
      status === 504 ||
      // General 403 can be temporary (e.g., token expired, or temporary account issue)
      (status === 403 && !isModelPermanentError(error)) // Only if not a permanent 403
    ) {
      return true
    }
    return false
  }

  // Helper to extract common error details
  function extractErrorDetails(error: unknown) {
    const errorObject = error && typeof error === "object" ? (error as Record<string, unknown>) : undefined
    const data =
      errorObject?.data && typeof errorObject.data === "object"
        ? (errorObject.data as Record<string, unknown>)
        : undefined
    const status =
      typeof errorObject?.status === "number"
        ? errorObject.status
        : typeof errorObject?.statusCode === "number"
          ? errorObject.statusCode
          : typeof data?.status === "number"
            ? data.status
            : undefined

    const responseBody =
      errorObject?.response && typeof errorObject.response === "object"
        ? (errorObject.response as Record<string, unknown>).body
        : undefined

    const message = typeof errorObject?.message === "string" ? errorObject.message : undefined

    const parts = [
      message,
      data?.message,
      data?.error && typeof data.error === "object" ? (data.error as Record<string, unknown>).message : undefined,
      errorObject?.responseBody,
      data?.responseBody,
      responseBody,
    ]
      .filter((item) => typeof item === "string")
      .join(" ")
      .toLowerCase()
    return { status, parts }
  }

  async function removeFavorite(providerId: string, modelID: string): Promise<boolean> {
    const file = Bun.file(path.join(Global.Path.state, "model.json"))
    if (!(await file.exists())) return false
    const data = (await file.json().catch(() => null)) as {
      favorite?: Array<{ providerId: string; modelID: string }>
    } | null
    if (!data || !Array.isArray(data.favorite)) return false
    const next = data.favorite.filter((item) => item.providerId !== providerId || item.modelID !== modelID)
    if (next.length === data.favorite.length) return false
    const updated = { ...data, favorite: next }
    await Bun.write(file, JSON.stringify(updated, null, 2))
    return true
  }

  export function create(input: {
    assistantMessage: MessageV2.Assistant
    sessionID: string
    model: Provider.Model
    accountId?: string
    abort: AbortSignal
  }) {
    const toolcalls: Record<string, MessageV2.ToolPart> = {}
    let snapshot: string | undefined
    let blocked = false
    let attempt = 0
    let needsCompaction = false
    // Track fallback attempts to prevent infinite loops
    const triedVectors = new Set<string>()
    let fallbackAttempts = 0
    // Cap total rotation attempts to avoid high-frequency retry loops that
    // can trigger server-side abuse detection / IP bans.
    const MAX_FALLBACK_ATTEMPTS = 8
    // Consecutive "no fallback found" counter — when rotation3d returns null
    // repeatedly, it means all accounts are exhausted. Stop early.
    let consecutiveNullFallbacks = 0
    const MAX_CONSECUTIVE_NULL_FALLBACKS = 2
    // SAFETY KILL SWITCH: global consecutive error counter.
    // Regardless of error type (401, 429, 500, etc.), if we fail this many
    // times in a row without a single successful stream, force-stop the loop.
    // This prevents infinite retry spirals that trigger server-side abuse detection.
    let consecutiveErrors = 0
    const MAX_CONSECUTIVE_ERRORS = 5

    // Session identity constraint for rotation — prevents subagent/session
    // from drifting to a different provider/account during rate-limit fallback.
    let sessionIdentity: { providerId: string; accountId?: string } | undefined

    const result = {
      get message() {
        return input.assistantMessage
      },
      partFromToolCall(toolCallID: string) {
        return toolcalls[toolCallID]
      },
      async process(streamInput: LLM.StreamInput) {
        log.info("process")
        needsCompaction = false
        const shouldBreak = (await Config.get()).experimental?.continue_loop_on_deny !== true

        // Read session's pinned execution identity once to constrain rotation.
        if (!sessionIdentity) {
          const sessionInfo = await Session.get(input.sessionID).catch(() => undefined)
          if (sessionInfo?.execution?.accountId) {
            sessionIdentity = {
              providerId: sessionInfo.execution.providerId,
              accountId: sessionInfo.execution.accountId,
            }
          }
        }

        while (true) {
          try {
            // Pre-flight rate-limit check: read shared rotation-state.json
            // before hitting the API. If the current vector is already marked
            // rate-limited (by this process or another subagent), proactively
            // switch to a fallback model without wasting an API request.
            {
              const { Account } = await import("@/account")
              const family = await Account.resolveFamily(streamInput.model.providerId)
              // Resolution chain: check all explicit sources, then session's
              // pinned execution identity, before falling back to global-active.
              // The execution identity check prevents internal agents (compaction,
              // etc.) from accidentally overwriting the user's chosen account.
              const explicitAccountId =
                streamInput.accountId ??
                input.accountId ??
                input.assistantMessage.accountId ??
                streamInput.user.model.accountId
              const sessionExecution = !explicitAccountId
                ? (await Session.get(input.sessionID))?.execution?.accountId
                : undefined
              const sessionPinnedAccountId = explicitAccountId ?? sessionExecution
              const accountId = sessionPinnedAccountId ?? (family ? await Account.getActive(family) : undefined)

              // SYSLOG: Full account resolution trace for Bug #1 diagnosis
              debugCheckpoint("syslog.session", "preflight account resolution trace", {
                sessionID: input.sessionID,
                providerId: streamInput.model.providerId,
                modelID: streamInput.model.id,
                resolution: {
                  streamInputAccountId: streamInput.accountId,
                  inputAccountId: input.accountId,
                  assistantMessageAccountId: input.assistantMessage.accountId,
                  userMessageAccountId: streamInput.user.model.accountId,
                  sessionExecutionAccountId: sessionExecution,
                  sessionPinnedAccountId,
                  globalActiveAccountId: family ? await Account.getActive(family) : undefined,
                  resolvedAccountId: accountId,
                  source: sessionPinnedAccountId
                    ? sessionExecution && sessionPinnedAccountId === sessionExecution
                      ? "session-execution"
                      : "pinned"
                    : "global-active",
                },
                family,
                fallbackAttempts,
              })

              // CHECKPOINT: ivon0829 tracker — fire whenever this account is resolved
              if (accountId && accountId.includes("ivon0829")) {
                debugCheckpoint("syslog.ivon0829", "⚠ ivon0829 resolved in processor preflight", {
                  sessionID: input.sessionID,
                  providerId: streamInput.model.providerId,
                  modelID: streamInput.model.id,
                  accountId,
                  source: sessionPinnedAccountId ? "session-pinned" : "global-active",
                  pinChain: {
                    streamInputAccountId: streamInput.accountId,
                    inputAccountId: input.accountId,
                    assistantMessageAccountId: input.assistantMessage.accountId,
                    userMessageAccountId: streamInput.user.model.accountId,
                  },
                  fallbackAttempts,
                  stack: new Error().stack,
                })
              }

              if (!sessionPinnedAccountId && accountId) {
                debugCheckpoint("rotation3d", "Pre-flight fell back to global active account", {
                  providerId: streamInput.model.providerId,
                  modelID: streamInput.model.id,
                  accountId,
                  sessionID: input.sessionID,
                })
                // FIX(Bug #1): Pin resolved account onto session so subsequent
                // requests in this session won't drift when the global active
                // account changes (e.g. via TUI dialog or another session).
                streamInput.accountId = accountId
                input.accountId = accountId
                input.assistantMessage.accountId = accountId
                await Session.pinExecutionIdentity({
                  sessionID: input.sessionID,
                  model: {
                    providerId: streamInput.model.providerId,
                    modelID: streamInput.model.id,
                    accountId,
                  },
                })
                debugCheckpoint("syslog.session", "pinned global-active account to session identity", {
                  sessionID: input.sessionID,
                  accountId,
                  providerId: streamInput.model.providerId,
                  modelID: streamInput.model.id,
                  note: "prevents silent account drift from global active changes",
                })
                // Update session identity constraint for rotation
                sessionIdentity = { providerId: streamInput.model.providerId, accountId }
              }
              if (accountId) {
                logSessionAccountAudit({
                  requestPhase: "preflight",
                  sessionID: input.sessionID,
                  userMessageID: streamInput.user.id,
                  assistantMessageID: input.assistantMessage.id,
                  providerId: streamInput.model.providerId,
                  modelID: streamInput.model.id,
                  accountId,
                  source: resolveAccountAuditSource({
                    explicitAccountId: streamInput.accountId ?? input.accountId ?? input.assistantMessage.accountId,
                    userMessageAccountId: streamInput.user.model.accountId,
                    resolvedAccountId: accountId,
                  }),
                  note: "processor preflight selected execution identity",
                })
              }
              if (accountId) {
                const vector = {
                  providerId: streamInput.model.providerId,
                  accountId,
                  modelID: streamInput.model.id,
                }
                if (isVectorRateLimited(vector)) {
                  const waitMs = getRateLimitTracker().getWaitTime(
                    accountId,
                    streamInput.model.providerId,
                    streamInput.model.id,
                  )
                  debugCheckpoint(
                    "rotation3d",
                    "Pre-flight: current vector is rate-limited, switching before API call",
                    {
                      providerId: streamInput.model.providerId,
                      modelID: streamInput.model.id,
                      accountId,
                      waitMs,
                      sessionID: input.sessionID,
                      fallbackAttempts,
                    },
                  )
                  fallbackAttempts++
                  if (fallbackAttempts <= MAX_FALLBACK_ATTEMPTS) {
                    const fallback = await LLM.handleRateLimitFallback(
                      streamInput.model,
                      "account-first",
                      triedVectors,
                      undefined,
                      accountId,
                      sessionIdentity,
                    )
                    if (fallback) {
                      log.info("Pre-flight: switched to fallback model", {
                        from: streamInput.model.id,
                        to: fallback.model.id,
                        fallbackAttempts,
                      })
                      streamInput.model = fallback.model
                      streamInput.accountId = fallback.accountId
                      input.model = fallback.model
                      input.accountId = fallback.accountId
                      input.assistantMessage.modelID = fallback.model.id
                      input.assistantMessage.providerId = fallback.model.providerId
                      input.assistantMessage.accountId = fallback.accountId
                      await Session.updateMessage(input.assistantMessage)
                      await Session.pinExecutionIdentity({
                        sessionID: input.sessionID,
                        model: {
                          providerId: input.assistantMessage.providerId,
                          modelID: input.assistantMessage.modelID,
                          accountId: input.assistantMessage.accountId,
                        },
                      })
                      logSessionAccountAudit({
                        requestPhase: "fallback-switch",
                        sessionID: input.sessionID,
                        userMessageID: streamInput.user.id,
                        assistantMessageID: input.assistantMessage.id,
                        providerId: fallback.model.providerId,
                        modelID: fallback.model.id,
                        accountId: fallback.accountId,
                        previousProviderId: vector.providerId,
                        previousModelID: vector.modelID,
                        previousAccountId: vector.accountId,
                        source: "rate-limit-fallback",
                        fallbackAttempts,
                        note: "preflight switched away from rate-limited vector",
                      })
                    } else {
                      // FIX(Bug #5): Pre-flight null fallback — all same-identity candidates
                      // are exhausted. Surface error and stop instead of proceeding to call
                      // LLM.stream with a known rate-limited vector (which would just fail again).
                      log.error("Pre-flight: no fallback available, all accounts rate-limited", {
                        providerId: streamInput.model.providerId,
                        modelID: streamInput.model.id,
                        accountId,
                        sessionID: input.sessionID,
                      })
                      debugCheckpoint("syslog.rotation", "CIRCUIT BREAKER: pre-flight no fallback, surfacing error", {
                        sessionID: input.sessionID,
                        providerId: streamInput.model.providerId,
                        modelID: streamInput.model.id,
                        accountId,
                        fallbackAttempts,
                        note: "all same-identity candidates exhausted at pre-flight, stopping",
                      })
                      const rateLimitError = new Error(
                        `All accounts for ${streamInput.model.providerId} are rate-limited. Please wait a few minutes.`,
                      )
                      input.assistantMessage.error = MessageV2.fromError(rateLimitError, {
                        providerId: streamInput.model.providerId,
                      })
                      Bus.publish(Session.Event.Error, {
                        sessionID: input.assistantMessage.sessionID,
                        error: input.assistantMessage.error,
                      })
                      SessionStatus.set(input.sessionID, { type: "idle" })
                      break
                    }
                  }
                }
              }
            }

            let currentText: MessageV2.TextPart | undefined
            let reasoningMap: Record<string, MessageV2.ReasoningPart> = {}
            const stream = await LLM.stream(streamInput)
            if (streamInput.accountId && input.assistantMessage.accountId !== streamInput.accountId) {
              // SYSLOG: Account changed after LLM.stream — potential silent account switch (Bug #1)
              debugCheckpoint("syslog.session", "post-stream account changed", {
                sessionID: input.sessionID,
                previousAccountId: input.assistantMessage.accountId,
                newAccountId: streamInput.accountId,
                providerId: input.assistantMessage.providerId,
                modelID: input.assistantMessage.modelID,
                note: "LLM.stream mutated streamInput.accountId — session identity is being silently switched",
              })
              input.accountId = streamInput.accountId
              input.assistantMessage.accountId = streamInput.accountId
              await Session.updateMessage(input.assistantMessage)
              await Session.pinExecutionIdentity({
                sessionID: input.sessionID,
                model: {
                  providerId: input.assistantMessage.providerId,
                  modelID: input.assistantMessage.modelID,
                  accountId: input.assistantMessage.accountId,
                },
              })
              logSessionAccountAudit({
                requestPhase: "assistant-persist",
                sessionID: input.sessionID,
                userMessageID: streamInput.user.id,
                assistantMessageID: input.assistantMessage.id,
                providerId: input.assistantMessage.providerId,
                modelID: input.assistantMessage.modelID,
                accountId: input.assistantMessage.accountId,
                source: "assistant-persist",
                note: "persisted resolved execution identity onto assistant message",
              })
            }

            for await (const value of stream.fullStream) {
              input.abort.throwIfAborted()
              switch (value.type) {
                case "start":
                  consecutiveErrors = 0 // Stream connected — reset kill switch
                  await clearPendingContinuation(input.sessionID)
                  SessionStatus.set(input.sessionID, { type: "busy" })
                  await Session.setWorkflowState({
                    sessionID: input.sessionID,
                    state: "running",
                    stopReason: undefined,
                    lastRunAt: Date.now(),
                  })
                  break

                case "reasoning-start":
                  if (value.id in reasoningMap) {
                    continue
                  }
                  reasoningMap[value.id] = {
                    id: Identifier.ascending("part"),
                    messageID: input.assistantMessage.id,
                    sessionID: input.assistantMessage.sessionID,
                    type: "reasoning",
                    text: "",
                    time: {
                      start: Date.now(),
                    },
                    metadata: value.providerMetadata,
                  }
                  break

                case "reasoning-delta":
                  if (value.id in reasoningMap) {
                    const part = reasoningMap[value.id]
                    part.text += value.text
                    if (value.providerMetadata) part.metadata = value.providerMetadata
                    if (part.text) await Session.updatePart({ part, delta: value.text })
                  }
                  break

                case "reasoning-end":
                  if (value.id in reasoningMap) {
                    const part = reasoningMap[value.id]
                    part.text = part.text.trimEnd()

                    part.time = {
                      ...part.time,
                      end: Date.now(),
                    }
                    if (value.providerMetadata) part.metadata = value.providerMetadata
                    await Session.updatePart(part)
                    delete reasoningMap[value.id]
                  }
                  break

                case "tool-input-start":
                  const part = await Session.updatePart({
                    id: toolcalls[value.id]?.id ?? Identifier.ascending("part"),
                    messageID: input.assistantMessage.id,
                    sessionID: input.assistantMessage.sessionID,
                    type: "tool",
                    tool: value.toolName,
                    callID: value.id,
                    state: {
                      status: "pending",
                      input: {},
                      raw: "",
                    },
                  })
                  toolcalls[value.id] = part as MessageV2.ToolPart
                  break

                case "tool-input-delta":
                  break

                case "tool-input-end":
                  break

                case "tool-call": {
                  const match = toolcalls[value.toolCallId]
                  if (match) {
                    const part = await Session.updatePart({
                      ...match,
                      tool: value.toolName,
                      state: {
                        status: "running",
                        input: value.input,
                        time: {
                          start: Date.now(),
                        },
                      },
                      metadata: value.providerMetadata,
                    })
                    toolcalls[value.toolCallId] = part as MessageV2.ToolPart

                    if (value.toolName === "task") {
                      await emitSessionNarration({
                        sessionID: input.sessionID,
                        parentID: input.assistantMessage.parentID,
                        agent: input.assistantMessage.agent,
                        variant: input.assistantMessage.variant,
                        model: {
                          providerId: input.assistantMessage.providerId,
                          modelID: input.assistantMessage.modelID,
                          accountId: input.assistantMessage.accountId,
                        },
                        text: describeTaskNarration({
                          phase: "start",
                          description:
                            typeof value.input?.description === "string"
                              ? value.input.description
                              : typeof value.input?.prompt === "string"
                                ? value.input.prompt
                                : undefined,
                          subagentType:
                            typeof value.input?.subagent_type === "string" ? value.input.subagent_type : undefined,
                        }),
                        kind: "task",
                        metadata: {
                          taskNarration: true,
                          taskPhase: "start",
                          toolCallId: value.toolCallId,
                        },
                      })
                    }

                    const parts = await MessageV2.parts(input.assistantMessage.id)
                    const lastThree = parts.slice(-DOOM_LOOP_THRESHOLD)

                    if (
                      lastThree.length === DOOM_LOOP_THRESHOLD &&
                      lastThree.every(
                        (p) =>
                          p.type === "tool" &&
                          p.tool === value.toolName &&
                          p.state.status !== "pending" &&
                          JSON.stringify(p.state.input) === JSON.stringify(value.input),
                      )
                    ) {
                      const agent = await Agent.get(input.assistantMessage.agent)
                      await PermissionNext.ask({
                        permission: "doom_loop",
                        patterns: [value.toolName],
                        sessionID: input.assistantMessage.sessionID,
                        metadata: {
                          tool: value.toolName,
                          input: value.input,
                        },
                        always: [value.toolName],
                        ruleset: agent.permission,
                      })
                    }
                  }
                  break
                }
                case "tool-result": {
                  const match = toolcalls[value.toolCallId]
                  if (match && match.state.status === "running") {
                    const attachments = materializeToolAttachments(value.output.attachments, {
                      messageID: match.messageID,
                      sessionID: match.sessionID,
                    })
                    await Session.updatePart({
                      ...match,
                      state: {
                        status: "completed",
                        input: value.input ?? match.state.input,
                        output: value.output.output,
                        metadata: value.output.metadata,
                        title: value.output.title,
                        time: {
                          start: match.state.time.start,
                          end: Date.now(),
                        },
                        attachments,
                      },
                    })

                    if (match.tool === "task") {
                      await emitSessionNarration({
                        sessionID: input.sessionID,
                        parentID: input.assistantMessage.parentID,
                        agent: input.assistantMessage.agent,
                        variant: input.assistantMessage.variant,
                        model: {
                          providerId: input.assistantMessage.providerId,
                          modelID: input.assistantMessage.modelID,
                          accountId: input.assistantMessage.accountId,
                        },
                        text: describeTaskNarration({
                          phase: "complete",
                          title: value.output.title,
                          output: value.output.output,
                        }),
                        kind: "task",
                        metadata: {
                          taskNarration: true,
                          taskPhase: "complete",
                          toolCallId: value.toolCallId,
                        },
                      })
                    }

                    delete toolcalls[value.toolCallId]
                  }
                  break
                }

                case "tool-error": {
                  const match = toolcalls[value.toolCallId]
                  if (match && match.state.status === "running") {
                    await Session.updatePart({
                      ...match,
                      state: {
                        status: "error",
                        input: value.input ?? match.state.input,
                        error: String(value.error),
                        time: {
                          start: match.state.time.start,
                          end: Date.now(),
                        },
                      },
                    })

                    if (match.tool === "task") {
                      await emitSessionNarration({
                        sessionID: input.sessionID,
                        parentID: input.assistantMessage.parentID,
                        agent: input.assistantMessage.agent,
                        variant: input.assistantMessage.variant,
                        model: {
                          providerId: input.assistantMessage.providerId,
                          modelID: input.assistantMessage.modelID,
                          accountId: input.assistantMessage.accountId,
                        },
                        text: describeTaskNarration({
                          phase: "error",
                          error: String(value.error),
                        }),
                        kind: "task",
                        metadata: {
                          taskNarration: true,
                          taskPhase: "error",
                          toolCallId: value.toolCallId,
                        },
                      })
                    }

                    if (
                      value.error instanceof PermissionNext.RejectedError ||
                      value.error instanceof Question.RejectedError
                    ) {
                      blocked = shouldBreak
                    }
                    delete toolcalls[value.toolCallId]
                  }
                  break
                }
                case "error":
                  throw value.error

                case "start-step":
                  snapshot = await Snapshot.track()
                  await Session.updatePart({
                    id: Identifier.ascending("part"),
                    messageID: input.assistantMessage.id,
                    sessionID: input.sessionID,
                    snapshot,
                    type: "step-start",
                  })
                  break

                case "finish-step":
                  const usage = Session.getUsage({
                    model: input.model,
                    usage: value.usage,
                    metadata: value.providerMetadata,
                  })
                  input.assistantMessage.finish = value.finishReason
                  input.assistantMessage.cost += usage.cost
                  input.assistantMessage.tokens = usage.tokens
                  await Session.updatePart({
                    id: Identifier.ascending("part"),
                    reason: value.finishReason,
                    snapshot: await Snapshot.track(),
                    messageID: input.assistantMessage.id,
                    sessionID: input.assistantMessage.sessionID,
                    type: "step-finish",
                    tokens: usage.tokens,
                    cost: usage.cost,
                  })
                  await Session.updateMessage(input.assistantMessage)
                  if (snapshot) {
                    const patch = await Snapshot.patch(snapshot)
                    if (patch.files.length) {
                      await Session.updatePart({
                        id: Identifier.ascending("part"),
                        messageID: input.assistantMessage.id,
                        sessionID: input.sessionID,
                        type: "patch",
                        hash: patch.hash,
                        files: patch.files,
                      })
                    }
                    snapshot = undefined
                  }
                  SessionSummary.summarize({
                    sessionID: input.sessionID,
                    messageID: input.assistantMessage.parentID,
                  })
                  // Record success on finish-step since 'finish' event might be skipped if compaction is needed
                  debugCheckpoint("health", "processor.finish-step", {
                    providerId: input.model.providerId,
                    modelID: input.model.id,
                    sessionID: input.sessionID,
                  })
                  await LLM.recordSuccess(
                    input.model.providerId,
                    input.model.id,
                    streamInput.accountId ?? input.accountId,
                  )
                  if (await SessionCompaction.isOverflow({ tokens: usage.tokens, model: input.model })) {
                    needsCompaction = true
                  }
                  break

                case "text-start":
                  currentText = {
                    id: Identifier.ascending("part"),
                    messageID: input.assistantMessage.id,
                    sessionID: input.assistantMessage.sessionID,
                    type: "text",
                    text: "",
                    time: {
                      start: Date.now(),
                    },
                    metadata: value.providerMetadata,
                  }
                  break

                case "text-delta":
                  if (currentText) {
                    currentText.text += value.text
                    if (value.providerMetadata) currentText.metadata = value.providerMetadata
                    if (currentText.text)
                      await Session.updatePart({
                        part: currentText,
                        delta: value.text,
                      })
                  }
                  break

                case "text-end":
                  if (currentText) {
                    currentText.text = currentText.text.trimEnd()
                    const textOutput = await Plugin.trigger(
                      "experimental.text.complete",
                      {
                        sessionID: input.sessionID,
                        messageID: input.assistantMessage.id,
                        partID: currentText.id,
                      },
                      { text: currentText.text },
                    )
                    currentText.text = textOutput.text
                    currentText.time = {
                      start: Date.now(),
                      end: Date.now(),
                    }
                    if (value.providerMetadata) currentText.metadata = value.providerMetadata
                    await Session.updatePart(currentText)
                  }
                  currentText = undefined
                  break

                case "finish":
                  // Record successful completion in global model health registry
                  log.info("finish event - recording success", {
                    providerId: input.model.providerId,
                    modelID: input.model.id,
                  })
                  debugCheckpoint("health", "processor.finish", {
                    providerId: input.model.providerId,
                    modelID: input.model.id,
                    sessionID: input.sessionID,
                  })
                  await LLM.recordSuccess(
                    input.model.providerId,
                    input.model.id,
                    streamInput.accountId ?? input.accountId,
                  )
                  break

                default:
                  log.info("unhandled", {
                    ...value,
                  })
                  continue
              }
              if (needsCompaction) break
            }
          } catch (e: any) {
            // SAFETY KILL SWITCH: unconditional consecutive error counter.
            // If we keep failing without ever reaching "start", force-stop.
            consecutiveErrors++
            if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
              log.error("KILL SWITCH: too many consecutive errors, force-stopping", {
                consecutiveErrors,
                fallbackAttempts,
                error: e?.message,
                status: (e as any)?.status ?? (e as any)?.statusCode,
              })
              debugCheckpoint("syslog.rotation", "KILL SWITCH: consecutive errors exceeded limit", {
                sessionID: input.sessionID,
                consecutiveErrors,
                fallbackAttempts,
                error: e?.message,
                status: (e as any)?.status ?? (e as any)?.statusCode,
                note: "force-stopping to prevent infinite retry spiral and server-side abuse detection",
              })
              input.assistantMessage.error = MessageV2.fromError(e, { providerId: input.model.providerId })
              Bus.publish(Session.Event.Error, {
                sessionID: input.assistantMessage.sessionID,
                error: input.assistantMessage.error,
              })
              SessionStatus.set(input.sessionID, { type: "idle" })
              break
            }

            // 1. Handle Temporary Errors (Rate Limit, Quota, Server Busy, Auth failures)
            if (isModelTemporaryError(e)) {
              // SYSLOG: Rate limit or temporary error hit — rotation should kick in
              debugCheckpoint("syslog.rotation", "temporary error: rotation3d should activate", {
                sessionID: input.sessionID,
                error: e.message,
                status: (e as any)?.status ?? (e as any)?.statusCode,
                providerId: streamInput.model.providerId,
                modelID: streamInput.model.id,
                accountId: streamInput.accountId ?? input.accountId ?? input.assistantMessage.accountId,
                fallbackAttempts,
                triedVectorCount: triedVectors.size,
              })
              debugCheckpoint("rotation3d", "Temporary failure detected", {
                error: e.message,
                model: streamInput.model.id,
                fallbackAttempts,
                triedVectors: Array.from(triedVectors),
              })

              fallbackAttempts++
              if (fallbackAttempts > MAX_FALLBACK_ATTEMPTS) {
                log.error("Max fallback attempts exceeded, stopping rotation", {
                  attempts: fallbackAttempts,
                  triedCount: triedVectors.size,
                })
                debugCheckpoint("syslog.rotation", "CIRCUIT BREAKER: max fallback attempts exceeded", {
                  sessionID: input.sessionID,
                  fallbackAttempts,
                  triedVectors: Array.from(triedVectors),
                  note: "stopping rotation to avoid server-side abuse detection",
                })
                // Surface error and stop — do NOT fall through to SessionRetry
                input.assistantMessage.error = MessageV2.fromError(e, { providerId: input.model.providerId })
                Bus.publish(Session.Event.Error, {
                  sessionID: input.assistantMessage.sessionID,
                  error: input.assistantMessage.error,
                })
                SessionStatus.set(input.sessionID, { type: "idle" })
                break
              } else {
                const fallback = await LLM.handleRateLimitFallback(
                  streamInput.model,
                  "account-first",
                  triedVectors,
                  e,
                  streamInput.accountId ??
                    input.accountId ??
                    input.assistantMessage.accountId ??
                    streamInput.user.model.accountId,
                  sessionIdentity,
                )
                if (fallback) {
                  consecutiveNullFallbacks = 0
                  log.info("Switching to fallback model (temporary error)", {
                    from: streamInput.model.id,
                    to: fallback.model.id,
                    fallbackAttempts,
                  })
                  streamInput.model = fallback.model
                  streamInput.accountId = fallback.accountId
                  input.model = fallback.model
                  input.accountId = fallback.accountId
                  input.assistantMessage.modelID = fallback.model.id
                  input.assistantMessage.providerId = fallback.model.providerId
                  input.assistantMessage.accountId = fallback.accountId
                  // Persist the updated modelID immediately so TUI can display the correct model
                  await Session.updateMessage(input.assistantMessage)
                  await Session.pinExecutionIdentity({
                    sessionID: input.sessionID,
                    model: {
                      providerId: input.assistantMessage.providerId,
                      modelID: input.assistantMessage.modelID,
                      accountId: input.assistantMessage.accountId,
                    },
                  })
                  logSessionAccountAudit({
                    requestPhase: "fallback-switch",
                    sessionID: input.sessionID,
                    userMessageID: streamInput.user.id,
                    assistantMessageID: input.assistantMessage.id,
                    providerId: fallback.model.providerId,
                    modelID: fallback.model.id,
                    accountId: fallback.accountId,
                    previousProviderId: streamInput.model.providerId,
                    previousModelID: streamInput.model.id,
                    previousAccountId:
                      streamInput.accountId ??
                      input.accountId ??
                      input.assistantMessage.accountId ??
                      streamInput.user.model.accountId,
                    source: "temporary-error-fallback",
                    fallbackAttempts,
                    error: e?.message,
                    note: "temporary error triggered fallback switch",
                  })
                  attempt = 0
                  await new Promise((resolve) => setTimeout(resolve, 100))
                  continue
                } else {
                  // No fallback available — all accounts exhausted.
                  // MUST break immediately to prevent fall-through to SessionRetry,
                  // which would retry with the same rate-limited vector in an infinite loop.
                  consecutiveNullFallbacks++
                  log.error("All accounts exhausted, surfacing error immediately", {
                    consecutiveNullFallbacks,
                    fallbackAttempts,
                    triedCount: triedVectors.size,
                  })
                  debugCheckpoint("syslog.rotation", "CIRCUIT BREAKER: no fallback, surfacing error (no retry fall-through)", {
                    sessionID: input.sessionID,
                    consecutiveNullFallbacks,
                    fallbackAttempts,
                    triedVectors: Array.from(triedVectors),
                    note: "immediate break prevents infinite retry with rate-limited vector",
                  })
                  input.assistantMessage.error = MessageV2.fromError(e, { providerId: input.model.providerId })
                  Bus.publish(Session.Event.Error, {
                    sessionID: input.assistantMessage.sessionID,
                    error: input.assistantMessage.error,
                  })
                  SessionStatus.set(input.sessionID, { type: "idle" })
                  break
                }
              }
            }

            // 2. Handle Permanent Errors (Model not found, invalid model)
            if (isModelPermanentError(e)) {
              debugCheckpoint("rotation3d", "Permanent failure detected", {
                error: e.message,
                model: streamInput.model.id,
                fallbackAttempts,
                triedVectors: Array.from(triedVectors),
              })

              const removed = await removeFavorite(streamInput.model.providerId, streamInput.model.id)
              if (removed) {
                log.warn("Removed invalid model from favorites", {
                  providerId: streamInput.model.providerId,
                  modelID: streamInput.model.id,
                })
              }

              // Trigger rotation to find a working model
              fallbackAttempts++
              if (fallbackAttempts <= MAX_FALLBACK_ATTEMPTS) {
                const fallback = await LLM.handleRateLimitFallback(
                  streamInput.model,
                  "account-first",
                  triedVectors,
                  e,
                  streamInput.accountId ??
                    input.accountId ??
                    input.assistantMessage.accountId ??
                    streamInput.user.model.accountId,
                  sessionIdentity,
                )
                if (fallback) {
                  consecutiveNullFallbacks = 0
                  log.info("Switching to fallback model (permanent error)", {
                    from: streamInput.model.id,
                    to: fallback.model.id,
                    fallbackAttempts,
                  })
                  streamInput.model = fallback.model
                  streamInput.accountId = fallback.accountId
                  input.model = fallback.model
                  input.accountId = fallback.accountId
                  input.assistantMessage.modelID = fallback.model.id
                  input.assistantMessage.providerId = fallback.model.providerId
                  input.assistantMessage.accountId = fallback.accountId
                  // Persist the updated modelID immediately so TUI can display the correct model
                  await Session.updateMessage(input.assistantMessage)
                  await Session.pinExecutionIdentity({
                    sessionID: input.sessionID,
                    model: {
                      providerId: input.assistantMessage.providerId,
                      modelID: input.assistantMessage.modelID,
                      accountId: input.assistantMessage.accountId,
                    },
                  })
                  logSessionAccountAudit({
                    requestPhase: "fallback-switch",
                    sessionID: input.sessionID,
                    userMessageID: streamInput.user.id,
                    assistantMessageID: input.assistantMessage.id,
                    providerId: fallback.model.providerId,
                    modelID: fallback.model.id,
                    accountId: fallback.accountId,
                    previousProviderId: streamInput.model.providerId,
                    previousModelID: streamInput.model.id,
                    previousAccountId:
                      streamInput.accountId ??
                      input.accountId ??
                      input.assistantMessage.accountId ??
                      streamInput.user.model.accountId,
                    source: "permanent-error-fallback",
                    fallbackAttempts,
                    error: e?.message,
                    note: "permanent error triggered fallback switch",
                  })
                  attempt = 0
                  await new Promise((resolve) => setTimeout(resolve, 100))
                  continue
                } else {
                  // No fallback for permanent error — break immediately
                  consecutiveNullFallbacks++
                  log.error("All accounts exhausted on permanent error, surfacing to user", {
                    consecutiveNullFallbacks,
                    fallbackAttempts,
                  })
                  input.assistantMessage.error = MessageV2.fromError(e, { providerId: input.model.providerId })
                  Bus.publish(Session.Event.Error, {
                    sessionID: input.assistantMessage.sessionID,
                    error: input.assistantMessage.error,
                  })
                  SessionStatus.set(input.sessionID, { type: "idle" })
                  break
                }
              }
            }

            log.error("process", {
              error: e,
              stack: JSON.stringify(e.stack),
            })
            const error = MessageV2.fromError(e, { providerId: input.model.providerId })
            if (MessageV2.ContextOverflowError.isInstance(error)) {
              // FIX: context overflow should trigger compaction instead of terminal error (@event_20260213_typecheck_and_review)
              needsCompaction = true
              break
            }
            const retry = SessionRetry.retryable(error)
            if (retry !== undefined) {
              // FIX: Before falling into retry-with-delay, attempt rotation first.
              // Rate limit errors that slip past isModelTemporaryError() (e.g. parsed
              // from JSON body as "too_many_requests" or "rate_limit") should still
              // trigger rotation instead of blindly retrying the same rate-limited vector.
              const isRateLimitRetry =
                retry === "Too Many Requests" ||
                retry === "Rate Limited" ||
                retry === "Provider is overloaded" ||
                isRateLimitError(e)
              if (isRateLimitRetry && fallbackAttempts <= MAX_FALLBACK_ATTEMPTS) {
                fallbackAttempts++
                const fallback = await LLM.handleRateLimitFallback(
                  streamInput.model,
                  "account-first",
                  triedVectors,
                  e,
                  streamInput.accountId ??
                    input.accountId ??
                    input.assistantMessage.accountId ??
                    streamInput.user.model.accountId,
                  sessionIdentity,
                )
                if (fallback) {
                  consecutiveNullFallbacks = 0
                  log.info("Retry-path rotation: switching to fallback", {
                    from: streamInput.model.id,
                    to: fallback.model.id,
                    retryMessage: retry,
                    fallbackAttempts,
                  })
                  streamInput.model = fallback.model
                  streamInput.accountId = fallback.accountId
                  input.model = fallback.model
                  input.accountId = fallback.accountId
                  input.assistantMessage.modelID = fallback.model.id
                  input.assistantMessage.providerId = fallback.model.providerId
                  input.assistantMessage.accountId = fallback.accountId
                  await Session.updateMessage(input.assistantMessage)
                  await Session.pinExecutionIdentity({
                    sessionID: input.sessionID,
                    model: {
                      providerId: input.assistantMessage.providerId,
                      modelID: input.assistantMessage.modelID,
                      accountId: input.assistantMessage.accountId,
                    },
                  })
                  logSessionAccountAudit({
                    requestPhase: "fallback-switch",
                    sessionID: input.sessionID,
                    userMessageID: streamInput.user.id,
                    assistantMessageID: input.assistantMessage.id,
                    providerId: fallback.model.providerId,
                    modelID: fallback.model.id,
                    accountId: fallback.accountId,
                    source: "rate-limit-fallback",
                    fallbackAttempts,
                    note: "rate limit retry redirected to rotation",
                  })
                  attempt = 0
                  await new Promise((resolve) => setTimeout(resolve, 100))
                  continue
                } else {
                  // No fallback — surface error immediately, don't retry
                  log.error("Retry-path rotation: no fallback, surfacing error", {
                    retryMessage: retry,
                    fallbackAttempts,
                  })
                  input.assistantMessage.error = error
                  Bus.publish(Session.Event.Error, {
                    sessionID: input.assistantMessage.sessionID,
                    error: input.assistantMessage.error,
                  })
                  SessionStatus.set(input.sessionID, { type: "idle" })
                  break
                }
              }

              // Non-rate-limit retryable errors: use normal retry-with-delay
              attempt++
              const delay = SessionRetry.delay(attempt, error.name === "APIError" ? error : undefined)
              SessionStatus.set(input.sessionID, {
                type: "retry",
                attempt,
                message: retry,
                next: Date.now() + delay,
              })
              await SessionRetry.sleep(delay, input.abort).catch(() => {})
              continue
            }
            input.assistantMessage.error = error
            Bus.publish(Session.Event.Error, {
              sessionID: input.assistantMessage.sessionID,
              error: input.assistantMessage.error,
            })
            SessionStatus.set(input.sessionID, { type: "idle" })
          }
          if (snapshot) {
            const patch = await Snapshot.patch(snapshot)
            if (patch.files.length) {
              await Session.updatePart({
                id: Identifier.ascending("part"),
                messageID: input.assistantMessage.id,
                sessionID: input.sessionID,
                type: "patch",
                hash: patch.hash,
                files: patch.files,
              })
            }
            snapshot = undefined
          }
          const p = await MessageV2.parts(input.assistantMessage.id)
          for (const part of p) {
            if (part.type === "tool" && part.state.status !== "completed" && part.state.status !== "error") {
              await Session.updatePart({
                ...part,
                state: {
                  ...part.state,
                  status: "error",
                  error: "Tool execution aborted",
                  time: {
                    start: Date.now(),
                    end: Date.now(),
                  },
                },
              })
            }
          }
          input.assistantMessage.time.completed = Date.now()
          await Session.updateMessage(input.assistantMessage)
          await Session.setWorkflowState({
            sessionID: input.sessionID,
            state: blocked ? "blocked" : "waiting_user",
            stopReason: blocked
              ? "permission_or_question_gate"
              : input.assistantMessage.error
                ? "assistant_error"
                : undefined,
            lastRunAt: Date.now(),
          })
          if (needsCompaction) return "compact"
          if (blocked) return "stop"
          if (input.assistantMessage.error) return "stop"
          return "continue"
        }
      },
    }
    return result
  }
}
