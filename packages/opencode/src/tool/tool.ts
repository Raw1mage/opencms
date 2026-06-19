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
    /**
     * Interactive-tool pause hook for the stream-idle watchdog
     * (plans/question-tool_idle-watchdog-false-kill, DD-1).
     *
     * Taxonomy:
     * - Name: `pauseIdleWatchdog`
     * - Is: a hook an interactive tool calls to suspend the stream-idle
     *   countdown while it legitimately awaits human input.
     * - Input: none.
     * - Output: a `resume: () => void` closure that re-arms the idle
     *   watchdog (idempotent — calling it twice is safe).
     * - MUST NOT be read as:
     *   • cancelling the whole stream's abort signal,
     *   • disabling `ctx.abort` for killswitch / manual-stop /
     *     session-switch / instance-dispose,
     *   • pausing the first-chunk watchdog (which fires before any
     *     tool runs, so it is out of scope of this hook).
     * - Done when: the idle timer does not fire between
     *   `pauseIdleWatchdog()` and `resume()`; after `resume()` the
     *   timer counts down from full again.
     *
     * Tools MUST call this inside a `try { ... } finally { resume?.() }`
     * so a throw from the inner await does not leave the watchdog
     * disarmed for the rest of the stream (which would silently disable
     * wedge detection for the whole turn — see design.md R1).
     *
     * Optional: when absent (e.g. small-model path or LLM.stream caller
     * that did not supply an idleWatchdogBox), the call falls through
     * via optional-chaining and the tool behaves as before the fix.
     */
    pauseIdleWatchdog?: () => () => void
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
    "system-manager_get_system_status": "exploration",
    "system-manager_get_session": "exploration",
    "system-manager_get_favorites": "exploration",
    "system-manager_list_subagents": "exploration",
    "system-manager_read_subsession": "exploration",
    "system-manager_list_mcp_apps": "exploration",
    edit: "modify",
    write: "modify",
    apply_patch: "modify",
    multiedit: "modify",
    notebookedit: "modify",
    scratchpad_write: "modify",
    "system-manager_switch_session": "modify",
    "system-manager_switch_model": "modify",
    "system-manager_switch_account": "modify",
    "system-manager_switch_provider": "modify",
    "system-manager_switch_theme": "modify",
    "system-manager_toggle_mcp": "modify",
    "system-manager_copy_to_clipboard": "modify",
    "system-manager_execute_command": "modify",
    "system-manager_update_models": "modify",
    "system-manager_switch_agent": "modify",
    "system-manager_open_in_editor": "modify",
    "system-manager_open_fileview": "modify",
    "system-manager_display_inline_image": "modify",
    "system-manager_rename_session": "modify",
    "system-manager_manage_session": "modify",
    "system-manager_app_control": "modify",
    "system-manager_set_ui_config": "modify",
    "system-manager_export_transcript": "modify",
    "system-manager_set_log_level": "modify",
    "system-manager_install_mcp_app": "modify",
    "system-manager_remove_mcp_app": "modify",
    "system-manager_restart_self": "modify",
    "system-manager_skill_loader": "modify",
    todowrite: "other",
    batch: "other",
    cancel_task: "other",
    task: "other",
  }

  /**
   * Returns the Working Cache classification for a tool id. Unknown ids default to
   * "other" so they neither poison the exploration counter nor get indexed as evidence.
   */
  export function kind(toolID: string): Kind {
    return TOOL_KIND_REGISTRY[toolID] ?? "other"
  }

  /**
   * Dedup-eligibility hints for MCP tools.
   * See issues/bug_20260619_dispatcher_dedup_short_circuits_forced_rebuild.md.
   *
   * The tool dispatcher (session/tool-invoker.ts) short-circuits byte-identical
   * (toolID, args) calls within one user turn. That is correct for pure
   * read/query tools, but WRONG for tools whose contract is "force a destructive
   * rebuild" (e.g. docxmcp_pptx_bootstrap(overwrite=true)): the second call is
   * meant to re-run the side effect, yet dedup silently reuses the stale result.
   *
   * MCP servers advertise this via tool annotations (readOnlyHint /
   * destructiveHint / idempotentHint). convertMcpTool() captures them here so
   * the dispatcher can decide.
   *
   * Native tools (read/edit/apply_patch/...) are NOT registered here, so they
   * fall through isDedupEligible() as eligible=true — preserving the existing
   * native dedup behaviour (notably apply_patch dedup from
   * issues/closed/bug_20260529_toolcall_duplicate_apply_patch_retry.md).
   */
  interface DedupHints {
    readOnlyHint?: boolean
    destructiveHint?: boolean
    idempotentHint?: boolean
  }
  const dedupHintsRegistry = new Map<string, DedupHints>()

  /**
   * Register MCP annotation hints for a tool id. Called by convertMcpTool().
   * Idempotent: latest registration wins (mirrors the tools-cache refresh).
   */
  export function registerDedupHints(toolID: string, hints: DedupHints): void {
    dedupHintsRegistry.set(toolID, {
      readOnlyHint: hints.readOnlyHint,
      destructiveHint: hints.destructiveHint,
      idempotentHint: hints.idempotentHint,
    })
  }

  /**
   * Whether a tool's identical-call dedup short-circuit is safe.
   *
   * - Native / unregistered tools → true (preserve existing dedup behaviour).
   * - MCP tools → true ONLY when explicitly readOnlyHint OR idempotentHint.
   *   destructiveHint, or no usable hint, → false (fail-safe: re-run rather
   *   than silently reuse a stale side-effecting result). This is an explicit
   *   no-dedup decision, NOT a silent fallback.
   */
  export function isDedupEligible(toolID: string): boolean {
    const hints = dedupHintsRegistry.get(toolID)
    if (!hints) return true
    return hints.readOnlyHint === true || hints.idempotentHint === true
  }

  // Test-only: clear the dedup-hints registry between cases.
  export function _clearDedupHintsForTest(): void {
    dedupHintsRegistry.clear()
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
          // [log-volume] per-call success telemetry — round telemetry already summarizes. Verbose-only.
          // Failure path above stays at info() for diagnostics.
          telemetryLog.debug("tool-call", {
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
