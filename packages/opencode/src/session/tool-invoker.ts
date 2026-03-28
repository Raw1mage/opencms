import { Log } from "../util/log"
import { MessageV2 } from "./message-v2"
import { Plugin } from "../plugin"
import { Tool } from "../tool/tool"
import { ulid } from "ulid"
import { debugCheckpoint } from "@/util/debug"
import { SessionPrompt } from "./prompt"
import type { PlannerIntent } from "./dialog-trigger"

const log = Log.create({ service: "tool-invoker" })

type ToolMetadataInput = Parameters<Tool.Context["metadata"]>[0]
type ToolAskInput = Parameters<Tool.Context["ask"]>[0]
type ToolExecutionResult = Awaited<ReturnType<Awaited<ReturnType<Tool.Info["init"]>>["execute"]>>

type InitializedTool<TResult = ToolExecutionResult> = {
  execute(args: unknown, ctx: Tool.Context): Promise<TResult>
}

type InvokableTool<TResult = ToolExecutionResult> = Tool.Info | InitializedTool<TResult>

const OPPOSITE_PLANNER_TOOL_BY_INTENT = {
  plan_exit: "plan_enter",
  plan_enter: "plan_exit",
} as const satisfies Record<PlannerIntent, string>

function hasInit<TResult>(tool: InvokableTool<TResult>): tool is Tool.Info {
  return typeof (tool as Tool.Info).init === "function"
}

async function assertPlannerIntentConsistency(options: ToolInvoker.InvokeOptions) {
  if (!options.toolID.startsWith("plan_")) return
  const committedPlannerIntent = await SessionPrompt.getCommittedPlannerIntent(options.sessionID)
  if (!committedPlannerIntent) return
  const forbiddenTool = OPPOSITE_PLANNER_TOOL_BY_INTENT[committedPlannerIntent]
  if (options.toolID !== forbiddenTool) return
  throw new Error(
    `planner_intent_mismatch: committed ${committedPlannerIntent} intent forbids opposite-direction ${options.toolID} invocation`,
  )
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

    await assertPlannerIntentConsistency(options)

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
