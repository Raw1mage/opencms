import { Log } from "../util/log"
import { MessageV2 } from "./message-v2"
import { Plugin } from "../plugin"
import { Tool } from "../tool/tool"
import { ulid } from "ulid"
import { debugCheckpoint } from "@/util/debug"
import { Session } from "."
import { SessionPrompt } from "./prompt"
import { WorkingCache } from "./working-cache"

const log = Log.create({ service: "tool-invoker" })

/**
 * Stable JSON.stringify with sorted keys, for tool-input signature hashing.
 * Two parallel calls with the same logical input but different key insertion
 * order should still hash to the same signature.
 *
 * Exported for unit tests.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]"
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") + "}"
}

/**
 * Duplicate tool-call detection across the current user turn. Codex (and
 * occasionally other providers) sometimes issue parallel OR sequential
 * tool calls with identical (toolID, args) within one user turn — same
 * step, separate steps in the same multi-step assistant message, or even
 * across consecutive assistant messages before the next user reply. This
 * wastes the user's tokens AND violates the "don't repeat work the model
 * already did" principle. We short-circuit duplicates by reading the
 * prior sibling's output and returning it without re-invoking the tool.
 *
 * Turn boundary:
 *   - Walk `Session.messages` from the end backwards.
 *   - Stop at the most recent user message (turn boundary). After a new
 *     user msg, we don't dedup — the user might intentionally ask for a
 *     re-run.
 *   - Within that range, scan all assistant tool parts.
 *
 * Match criteria:
 *   - Same `tool` (toolID), same `state.input` (under stable JSON
 *     stringify so key-order doesn't matter).
 *   - Sibling status must be `completed` with a string output. `running`
 *     siblings are not awaited (race tolerance); `error` siblings don't
 *     dedupe (a retry might succeed).
 *   - Self-exclusion via callID prevents matching the in-flight part.
 *
 * Failure mode:
 *   Best-effort. If `Session.messages` throws or returns unexpected
 *   shapes, we log a warning and fall through to normal execution.
 */
async function findDuplicateSibling(
  sessionID: string,
  toolID: string,
  args: unknown,
  callID: string,
): Promise<MessageV2.ToolPart | undefined> {
  const msgs = await Session.messages({ sessionID })
  return findDuplicateSiblingInMessages(msgs, toolID, args, callID)
}

/**
 * Pure helper for unit testing — same logic as findDuplicateSibling but
 * accepts the messages array directly (no I/O).
 */
export function findDuplicateSiblingInMessages(
  msgs: MessageV2.WithParts[],
  toolID: string,
  args: unknown,
  callID: string,
): MessageV2.ToolPart | undefined {
  const sigKey = stableStringify(args)
  for (let i = msgs.length - 1; i >= 0; i--) {
    const msg = msgs[i]
    if (msg.info.role === "user") break // turn boundary
    if (msg.info.role !== "assistant") continue
    for (const p of msg.parts) {
      if (p.type !== "tool") continue
      const tp = p as MessageV2.ToolPart
      if (tp.callID === callID) continue
      if (tp.tool !== toolID) continue
      const state = tp.state as { status: string; input?: unknown; output?: string }
      if (state.status !== "completed") continue
      if (typeof state.output !== "string") continue
      if (stableStringify(state.input) !== sigKey) continue
      return tp
    }
  }
  return undefined
}

type ToolMetadataInput = Parameters<Tool.Context["metadata"]>[0]
type ToolAskInput = Parameters<Tool.Context["ask"]>[0]
type ToolExecutionResult = Awaited<ReturnType<Awaited<ReturnType<Tool.Info["init"]>>["execute"]>>

type InitializedTool<TResult = ToolExecutionResult> = {
  execute(args: unknown, ctx: Tool.Context): Promise<TResult>
}

type InvokableTool<TResult = ToolExecutionResult> = Tool.Info | InitializedTool<TResult>

function hasInit<TResult>(tool: InvokableTool<TResult>): tool is Tool.Info {
  return typeof (tool as Tool.Info).init === "function"
}

export namespace ToolInvoker {
  /**
   * Options for tool invocation
   */
  export interface InvokeOptions {
    sessionID: string
    messageID: string // Assistant message ID that contains the tool call
    toolID: string
    args: unknown
    agent: string
    abort: AbortSignal
    messages: MessageV2.WithParts[]
    extra?: Record<string, unknown>
    callID?: string // External callID (e.g. from AI SDK or TaskTool loop)
    onMetadata?: (input: ToolMetadataInput) => void | Promise<void>
    onAsk?: (input: ToolAskInput) => Promise<void>
  }

  /**
   * Executes a tool with standardized lifecycle management.
   * Centralizes Plugin hooks and Tool Context creation.
   */
  export async function execute(tool: Tool.Info, options: InvokeOptions): Promise<ToolExecutionResult>
  export async function execute<TResult>(tool: InitializedTool<TResult>, options: InvokeOptions): Promise<TResult>
  export async function execute<TResult>(
    tool: InvokableTool<TResult>,
    options: InvokeOptions,
  ): Promise<TResult | ToolExecutionResult> {
    const {
      sessionID,
      messageID,
      toolID,
      args,
      agent,
      abort,
      messages,
      extra,
      callID: providedCallID,
      onMetadata,
      onAsk,
    } = options
    const callID = providedCallID ?? ulid()

    debugCheckpoint("tool.invoke", "start", {
      tool: toolID,
      sessionID,
      messageID,
      callID,
      agent,
    })

    // Duplicate tool-call dedup (2026-05-10 hotfix). Codex occasionally
    // issues identical (toolID, args) tool calls within the same user
    // turn — parallel within a step, across steps in one assistant
    // message, or across consecutive assistant messages before the next
    // user reply. Short-circuit by returning the prior sibling's output
    // so we don't re-execute the tool. Saves user tokens and prevents
    // wasted compute. See header comment on findDuplicateSibling for
    // boundary rules.
    try {
      const dup = await findDuplicateSibling(sessionID, toolID, args, callID)
      if (dup) {
        const dupOutput = (dup.state as { output?: string }).output ?? ""
        debugCheckpoint("tool.invoke", "dedup-shortcircuit", {
          tool: toolID,
          sessionID,
          messageID,
          callID,
          siblingCallID: dup.callID,
          siblingMessageID: dup.messageID,
          outputBytes: dupOutput.length,
        })
        log.info("dedup: short-circuited identical tool call", {
          toolID,
          callID,
          siblingCallID: dup.callID,
        })
        return {
          output: dupOutput,
          metadata: {
            dedup: {
              shortCircuited: true,
              siblingCallID: dup.callID,
              siblingMessageID: dup.messageID,
              reason: "identical (tool, args) within current user turn",
            },
          },
        } as ToolExecutionResult
      }
    } catch (err) {
      // Dedup is best-effort; if the lookup fails for any reason
      // (storage hiccup, missing parts) fall through to normal execution.
      log.warn("dedup lookup failed; falling through to execution", {
        toolID,
        callID,
        error: err instanceof Error ? err.message : String(err),
      })
    }

    await Plugin.trigger(
      "tool.execute.before",
      {
        tool: toolID,
        sessionID,
        callID,
      },
      { args },
    )

    const ctx: Tool.Context = {
      sessionID,
      messageID,
      agent,
      abort,
      callID,
      extra,
      messages,
      metadata: async (input) => {
        if (onMetadata) {
          await onMetadata(input)
        }
      },
      ask: async (input) => {
        if (onAsk) {
          await onAsk(input)
        }
      },
    }

    try {
      const toolInstance = hasInit(tool) ? await tool.init({ agent: { name: agent } as any }) : tool
      const result = await toolInstance.execute(args, ctx)

      debugCheckpoint("tool.invoke", "end", {
        tool: toolID,
        sessionID,
        callID,
      })

      // Working Cache exploration-sequence depth + L1 postscript injection
      // (plans/20260507_working-cache-local-cache/ DD-7 / DD-8). Tick the
      // counter on every native toolcall (MCP tools have their own surface
      // and don't tick the native counter). When depth crosses the threshold,
      // append a single postscript inviting cache-digest emission to the next
      // assistant turn.
      const toolKind = Tool.kind(toolID)
      const depth = WorkingCache.tickExplorationDepth(sessionID, toolKind)
      if (toolKind === "exploration") {
        const postscript = WorkingCache.explorationPostscript(depth)
        if (postscript.length > 0 && typeof (result as any)?.output === "string") {
          ;(result as any).output = (result as any).output + "\n" + postscript
          debugCheckpoint("working-cache.exploration", "postscript-emit", {
            sessionID,
            tool: toolID,
            callID,
            depth,
          })
        }
      }

      await Plugin.trigger(
        "tool.execute.after",
        {
          tool: toolID,
          sessionID,
          callID,
          args,
        },
        result,
      )

      return result
    } catch (error) {
      debugCheckpoint("tool.invoke", "error", {
        tool: toolID,
        sessionID,
        callID,
        message: error instanceof Error ? error.message : String(error),
      })
      log.error("tool execution failed", { toolID, error })
      throw error
    }
  }

  /**
   * Error class for tool invocation failures
   */
  export class ToolInvocationError extends Error {
    constructor(
      public readonly toolName: string,
      message: string,
      public readonly originalError?: Error,
    ) {
      super(`[${toolName}] ${message}`)
      this.name = "ToolInvocationError"
    }
  }

  /**
   * Input configuration for task tool invocation
   */
  export interface TaskInvokeInput {
    /** Structured or text input - supports both formats */
    input:
      | string
      | {
          /** Task type: analysis, implementation, review, etc. */
          type: "analysis" | "implementation" | "review" | "testing" | "documentation"
          /** Task content/description */
          content: string
          /** Optional metadata for the task */
          metadata?: Record<string, unknown>
        }
    /** Optional timeout in milliseconds */
    timeout?: number
  }

  /**
   * Result of a tool invocation
   */
  export interface InvocationResult<T = unknown> {
    /** Whether the invocation succeeded */
    success: boolean
    /** Result data (tool-specific) */
    data?: T
    /** Error message if failed */
    error?: string
    /** Execution time in milliseconds */
    duration: number
  }

  /**
   * Normalizes task input - converts complex structures to simple text for tool compatibility
   */
  export function normalizeTaskInput(
    input:
      | string
      | {
          type: "analysis" | "implementation" | "review" | "testing" | "documentation"
          content: string
          metadata?: Record<string, unknown>
        },
  ): string {
    if (typeof input === "string") {
      return input
    }

    let result = `[${input.type.toUpperCase()}]\n${input.content}`
    if (input.metadata && Object.keys(input.metadata).length > 0) {
      result += `\n\nMetadata: ${JSON.stringify(input.metadata, null, 2)}`
    }
    return result
  }

  /**
   * Internal helper for tool invocation with consistent error handling
   */
  export async function _invokeWithErrorHandling<T>(
    toolName: string,
    fn: () => Promise<T>,
  ): Promise<InvocationResult<T>> {
    const startTime = Date.now()

    try {
      log.debug(`Invoking ${toolName} tool`)
      const result = await fn()
      const duration = Date.now() - startTime

      log.info(`${toolName} tool invocation succeeded`, { duration })
      return {
        success: true,
        data: result,
        duration,
      }
    } catch (err) {
      const duration = Date.now() - startTime
      const errorMessage = err instanceof Error ? err.message : String(err)

      log.error(`${toolName} tool invocation failed`, {
        error: errorMessage,
        duration,
      })

      return {
        success: false,
        error: errorMessage,
        duration,
      }
    }
  }

  /**
   * Checks if a tool invocation result succeeded
   */
  export function isSuccess<T>(result: InvocationResult<T>): result is InvocationResult<T> & { data: T } {
    return result.success && result.data !== undefined
  }

  /**
   * Gets detailed error information from an invocation result
   */
  export function getErrorDetails(result: InvocationResult) {
    if (result.success) return undefined
    return {
      message: result.error,
      duration: result.duration,
    }
  }

  /**
   * Retries a tool invocation with exponential backoff
   */
  export async function withRetry<T>(
    fn: () => Promise<InvocationResult<T>>,
    maxAttempts: number = 3,
    initialDelayMs: number = 1000,
  ): Promise<InvocationResult<T>> {
    let lastError: InvocationResult<T> | undefined

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const result = await fn()
      if (result.success) {
        return result
      }

      lastError = result

      if (attempt < maxAttempts) {
        const delayMs = initialDelayMs * Math.pow(2, attempt - 1)
        log.debug(`Retrying tool invocation (attempt ${attempt}/${maxAttempts})`, { delayMs })
        await new Promise((resolve) => setTimeout(resolve, delayMs))
      }
    }

    return (
      lastError || {
        success: false,
        error: "Unknown error",
        duration: 0,
      }
    )
  }
}
