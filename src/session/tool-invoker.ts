/**
 * ToolInvoker: Centralized tool invocation module
 *
 * This module provides a unified interface for invoking tools (Task, Bash, etc.)
 * with consistent error handling and a testable API.
 *
 * Motivation:
 * - Reduces duplication of tool invocation logic across the codebase
 * - Provides consistent error handling and logging
 * - Makes testing easier through dependency injection
 * - Centralizes configuration and version management
 *
 * TODO #2 Resolution: Extracted tool invocation logic into a dedicated namespace
 * with consistent patterns for error handling and result reporting.
 */

import { Log } from "../util/log"

const log = Log.create({ service: "tool-invoker" })

export namespace ToolInvoker {
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
   *
   * TODO #3 Resolution: Updated to accept both simple strings and complex structured input
   * The input field now uses a union type to support:
   * - Simple text string: for basic task descriptions
   * - Structured object: for complex tasks with metadata
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
   *
   * @param input - The input to normalize
   * @returns Normalized text representation
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

    // Convert structured input to human-readable format
    let result = `[${input.type.toUpperCase()}]\n${input.content}`
    if (input.metadata && Object.keys(input.metadata).length > 0) {
      result += `\n\nMetadata: ${JSON.stringify(input.metadata, null, 2)}`
    }
    return result
  }

  /**
   * Internal helper for tool invocation with consistent error handling
   *
   * @param toolName - Name of the tool being invoked
   * @param fn - Function that performs the actual tool invocation
   * @returns InvocationResult with success status and data
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
   *
   * @param result - The invocation result to check
   * @returns true if the invocation succeeded
   */
  export function isSuccess<T>(result: InvocationResult<T>): result is InvocationResult<T> & { data: T } {
    return result.success && result.data !== undefined
  }

  /**
   * Gets detailed error information from an invocation result
   *
   * @param result - The invocation result
   * @returns Error details if failed, undefined if succeeded
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
   *
   * @param fn - Function to invoke
   * @param maxAttempts - Maximum number of attempts (default: 3)
   * @param initialDelayMs - Initial delay in milliseconds (default: 1000)
   * @returns InvocationResult from the successful invocation
   *
   * @example
   * const result = await ToolInvoker.withRetry(
   *   () => ToolInvoker._invokeWithErrorHandling("task", async () => {
   *     // perform task invocation
   *   }),
   *   3,
   *   1000
   * )
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
