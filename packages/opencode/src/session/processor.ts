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

    // Temporary errors: rate limit, quota, server errors, general 403 (could be temporary token issue)
    if (
      isRateLimitError(error) ||
      parts.includes("quota exceeded") ||
      parts.includes("rate limit") ||
      parts.includes("overloaded") ||
      parts.includes("server error") ||
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
    // Allow many attempts to find a working model across all accounts/providers
    const MAX_FALLBACK_ATTEMPTS = 50

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
        while (true) {
          try {
            // Pre-flight rate-limit check: read shared rotation-state.json
            // before hitting the API. If the current vector is already marked
            // rate-limited (by this process or another subagent), proactively
            // switch to a fallback model without wasting an API request.
            {
              const { Account } = await import("@/account")
              const family = await Account.resolveFamily(streamInput.model.providerId)
              const accountId =
                streamInput.accountId ?? input.accountId ?? (family ? await Account.getActive(family) : undefined)
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
                    }
                  }
                }
              }
            }

            let currentText: MessageV2.TextPart | undefined
            let reasoningMap: Record<string, MessageV2.ReasoningPart> = {}
            const stream = await LLM.stream(streamInput)

            for await (const value of stream.fullStream) {
              input.abort.throwIfAborted()
              switch (value.type) {
                case "start":
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
            // 1. Handle Temporary Errors (Rate Limit, Quota, Server Busy)
            if (isModelTemporaryError(e)) {
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
              } else {
                const fallback = await LLM.handleRateLimitFallback(
                  streamInput.model,
                  "account-first",
                  triedVectors,
                  e,
                  streamInput.accountId ?? input.accountId,
                )
                if (fallback) {
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
                  attempt = 0
                  await new Promise((resolve) => setTimeout(resolve, 100))
                  continue
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
                  streamInput.accountId ?? input.accountId,
                )
                if (fallback) {
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
                  attempt = 0
                  await new Promise((resolve) => setTimeout(resolve, 100))
                  continue
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
