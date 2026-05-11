import z from "zod"
import type { MessageV2 } from "../session/message-v2"
import type { Agent } from "../agent/agent"
import type { PermissionNext } from "../permission/next"
import { Truncate } from "./truncation"
import { Log } from "../util/log"

const telemetryLog = Log.create({ service: "tool-telemetry" })

function byteSize(value: unknown): number {
  if (value === undefined || value === null) return 0
  if (typeof value === "string") return Buffer.byteLength(value, "utf8")
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8")
  } catch {
    return -1
  }
}

export namespace Tool {
  interface Metadata {
    [key: string]: any
  }

  export interface InitContext {
    agent?: Agent.Info
  }

  export type Context<M extends Metadata = Metadata> = {
    sessionID: string
    messageID: string
    agent: string
    abort: AbortSignal
    callID?: string
    extra?: { [key: string]: any }
    messages: MessageV2.WithParts[]
    metadata(input: { title?: string; metadata?: M }): void
    ask(input: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">): Promise<void>
    /**
     * Layer 2 (context-management spec, DD-2): per-invocation token budget
     * for this tool's output. Variable-size tools (read/glob/grep/bash/
     * webfetch/apply_patch/task/read_subsession) MUST cap their natural
     * output to this many tokens before returning, appending a trailing
     * natural-language hint with the next-slice args.
     *
     * Computed by ToolBudget.compute() (helper) as
     *   min(round(model.contextWindow * contextRatio), absoluteCap)
     * floored at minimumFloor. May be undefined if the runtime has not
     * yet populated it; tools should call ToolBudget.resolve(ctx) to get
     * a guaranteed value.
     */
    outputBudget?: number
  }
  export interface Info<Parameters extends z.ZodType = z.ZodType, M extends Metadata = Metadata> {
    id: string
    source?: string
    init: (ctx?: InitContext) => Promise<{
      description: string
      parameters: Parameters
      execute(
        args: z.infer<Parameters>,
        ctx: Context,
      ): Promise<{
        title: string
        metadata: M
        output: string
        attachments?: Omit<MessageV2.FilePart, "id" | "sessionID" | "messageID">[]
      }>
      formatValidationError?(error: z.ZodError): string
    }>
  }

  export type InferParameters<T extends Info> = T extends Info<infer P> ? z.infer<P> : never
  export type InferMetadata<T extends Info> = T extends Info<any, infer M> ? M : never

  /**
   * Working Cache classification (plans/20260507_working-cache-local-cache/ DD-1, DD-7).
   * Drives the L2 ledger filter and the L1 exploration-sequence depth counter.
   *
   * - "exploration" — read-class tools that produce evidence (Read, Grep, Glob, codesearch,
   *   webfetch, read_subsession, attachment). Counts toward exploration depth and is
   *   indexed into the L2 ledger for future recall.
   * - "modify" — tools that write to the repo or external state (Edit, Write,
   *   apply_patch, NotebookEdit, scratchpad write paths, system-manager mutations).
   *   Resets the exploration depth counter.
   * - "other" — neutral tools that neither produce evidence nor reset the counter
   *   (todowrite, batch, cancel-task, agent control). Does not affect L1 trigger.
   *
   * Bash is "exploration" by default since the majority of bash usage in this codebase
   * is read-class (ls / grep / cat / git status). Explicit reclassification can be done
   * later if the data shows otherwise.
   */
  export type Kind = "exploration" | "modify" | "other"

  const TOOL_KIND_REGISTRY: Record<string, Kind> = {
    read: "exploration",
    glob: "exploration",
    grep: "exploration",
    codesearch: "exploration",
    webfetch: "exploration",
    bash: "exploration",
    attachment: "exploration",
    read_subsession: "exploration",
    edit: "modify",
    write: "modify",
    apply_patch: "modify",
    multiedit: "modify",
    notebookedit: "modify",
    scratchpad_write: "modify",
    todowrite: "other",
    batch: "other",
    "cancel-task": "other",
    task: "other",
  }

  /**
   * Returns the Working Cache classification for a tool id. Unknown ids default to
   * "other" so they neither poison the exploration counter nor get indexed as evidence.
   */
  export function kind(toolID: string): Kind {
    return TOOL_KIND_REGISTRY[toolID] ?? "other"
  }

  export function define<Parameters extends z.ZodType, Result extends Metadata>(
    id: string,
    init: Info<Parameters, Result>["init"] | Awaited<ReturnType<Info<Parameters, Result>["init"]>>,
  ): Info<Parameters, Result> {
    return {
      id,
      init: async (initCtx) => {
        const toolInfo = init instanceof Function ? await init(initCtx) : init
        const execute = toolInfo.execute
        toolInfo.execute = async (args, ctx) => {
          let parsed: z.infer<Parameters>
          try {
            parsed = toolInfo.parameters.parse(args) as z.infer<Parameters>
          } catch (error) {
            if (error instanceof z.ZodError && toolInfo.formatValidationError) {
              throw new Error(toolInfo.formatValidationError(error), { cause: error })
            }
            throw new Error(
              `The ${id} tool was called with invalid arguments: ${error}.\nPlease rewrite the input so it satisfies the expected schema.`,
              { cause: error },
            )
          }
          const inputBytes = byteSize(parsed)
          const startedAt = Date.now()
          let result
          try {
            result = await execute(parsed, ctx)
          } catch (err) {
            const durationMs = Date.now() - startedAt
            telemetryLog.info("tool-call", {
              tool: id,
              ok: false,
              durationMs,
              inputBytes,
              sessionID: ctx.sessionID,
              messageID: ctx.messageID,
              callID: ctx.callID,
              error: err instanceof Error ? err.message : String(err),
            })
            throw err
          }
          const durationMs = Date.now() - startedAt
          telemetryLog.info("tool-call", {
            tool: id,
            ok: true,
            durationMs,
            inputBytes,
            outputBytes: byteSize(result.output),
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
            callID: ctx.callID,
          })
          // skip truncation for tools that handle it themselves
          if (result.metadata.truncated !== undefined) {
            return result
          }
          const truncated = await Truncate.output(result.output, {}, initCtx?.agent, ctx.sessionID)
          return {
            ...result,
            output: truncated.content,
            metadata: {
              ...result.metadata,
              truncated: truncated.truncated,
              ...(truncated.truncated && { outputPath: truncated.outputPath }),
            },
          }
        }
        return toolInfo
      },
    }
  }
}
