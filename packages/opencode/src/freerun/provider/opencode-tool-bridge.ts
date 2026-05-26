/**
 * harness/freerun-mode — bridge that lets the freerun engine reuse
 * opencode's existing tool implementations (bash / read / write / edit /
 * grep / glob / apply_patch / tool_loader / …) instead of re-implementing
 * tool dispatch.
 *
 * Approach:
 *   - Catalog: the same ALWAYS_PRESENT_TOOLS set opencode uses for lite-
 *     mode sessions, MINUS task / cancel_task (DD-20 forbids subagents).
 *   - Lazy unlock: tool_loader is in the catalog; the model can request
 *     additional tools (webfetch / skill / mcp / etc.) on demand.
 *   - Dispatch: for each tool_call, look up the Tool.Info by name, init()
 *     to obtain the execute function, construct a minimal Tool.Context,
 *     await execute(args, ctx), return ctx.output as a string.
 *   - Safety inherits free: opencode BashTool's denylist + the freerun
 *     sudo gate I added earlier both fire automatically.
 */

// Direct imports — ToolRegistry.all() is module-private; importing the
// individual tool exports gives us a stable, type-safe surface without
// reaching into registry internals.
import { BashTool } from "../../tool/bash"
import { ReadTool } from "../../tool/read"
import { WriteTool } from "../../tool/write"
import { EditTool } from "../../tool/edit"
import { GlobTool } from "../../tool/glob"
import { GrepTool } from "../../tool/grep"
import { ApplyPatchTool } from "../../tool/apply_patch"
import { TodoWriteTool, TodoReadTool } from "../../tool/todo"
import { SessionRecallTool } from "../../tool/session-recall"
import { ToolLoaderTool } from "../../tool/tool-loader"
import { Log } from "../../util/log"
import type { Tool } from "../../tool/tool"
import type { Iterate } from "../runtime/iterate"
import type { ToolFilter } from "../render/tool-filter"
import { asSchema, type Tool as AITool } from "@ai-sdk/provider-utils"

const log = Log.create({ service: "freerun.opencode-tool-bridge" })

export namespace OpencodeToolBridge {
  /**
   * The default tool catalog for freerun-engine sessions.
   *
   * Starts from opencode's `ALWAYS_PRESENT_TOOLS` (bash, read, grep, glob,
   * apply_patch, todowrite, todoread, tool_loader, session_recall) and:
   *   - REMOVES task / cancel_task (DD-20)
   *   - REMOVES question (no interactive user during freerun iteration)
   *   - ADDS write + edit (file mutation primitives — needed for any
   *     code-producing task; opencode keeps these out of always-present
   *     because turn-mode AIs are expected to apply_patch instead, but
   *     freerun's smaller models do better with direct write/edit)
   */
  /**
   * The freerun engine's default tool set. Chosen for code-producing
   * tasks (bash + file mutation) plus the lazy-loader for self-service
   * unlocking. Excludes `task` / `cancel_task` (DD-20), `question` (no
   * interactive user during iteration), and MCP tools (catalog kept
   * small + predictable; model can `tool_loader` if it really needs).
   */
  const FREERUN_TOOLS: Tool.Info[] = [
    BashTool,
    ReadTool,
    WriteTool,
    EditTool,
    GlobTool,
    GrepTool,
    ApplyPatchTool,
    TodoWriteTool,
    TodoReadTool,
    SessionRecallTool,
    ToolLoaderTool,
  ]

  /** Build the tool catalog (shapes consumed by Iterate / ToolFilter). */
  export async function buildCatalog(): Promise<ToolFilter.ToolRecord[]> {
    const out: ToolFilter.ToolRecord[] = []
    for (const t of FREERUN_TOOLS) {
      const init = await t.init().catch((err) => {
        log.warn("tool init failed during catalog build", {
          tool: t.id,
          error: err instanceof Error ? err.message : err,
        })
        return null
      })
      if (!init) continue
      const parameters = jsonSchemaFromZod(init.parameters as any)
      out.push({
        name: t.id,
        description: init.description,
        parameters,
      } as ToolFilter.ToolRecord)
    }
    return out
  }

  /** Build a tool-loader-style table-of-contents string for FREERUN.md / prompt injection. */
  export async function buildToc(): Promise<string> {
    const lines: string[] = ["<freerun-tool-catalog>"]
    for (const t of FREERUN_TOOLS) {
      const init = await t.init().catch(() => null)
      if (!init) continue
      const firstLine = init.description.split("\n")[0].slice(0, 100)
      lines.push(`- **${t.id}**: ${firstLine}`)
    }
    lines.push("</freerun-tool-catalog>")
    return lines.join("\n")
  }

  /** Build the runtime ToolDispatcher for FreerunLlmClient. */
  export function buildDispatcher(opts: {
    sessionID: string
    messageID?: string
    agent?: string
    outputBudget?: number
  }): Iterate.LlmClient extends infer _ ? { dispatch: (name: string, args: unknown) => Promise<string> } : never {
    const ctxBase = {
      sessionID: opts.sessionID,
      messageID: opts.messageID ?? `freerun-msg-${Date.now()}`,
      agent: opts.agent ?? "freerun",
      outputBudget: opts.outputBudget ?? 8000, // tokens; opencode default is similar
    }

    return {
      async dispatch(name: string, args: unknown): Promise<string> {
        const tool = FREERUN_TOOLS.find((t) => t.id === name)
        if (!tool) {
          // Tool not in freerun's default set. Could be hallucinated, or
          // model thought it could use an MCP tool. Suggest tool_loader.
          const reason = `tool '${name}' is not in the freerun default catalog`
          log.warn(reason, { sessionID: opts.sessionID })
          return `Error: ${reason}. If you genuinely need it, call tool_loader with {"tools":["${name}"]} first (note: freerun-mode strips subagent/MCP tools by default — many tool names you remember from turn-mode are not present here).`
        }
        const init = await tool.init().catch((err) => {
          log.warn("tool init failed", { tool: name, error: err instanceof Error ? err.message : err })
          return null
        })
        if (!init) return `Error: tool '${name}' failed to initialize.`

        // Validate args against the tool's parameter schema. Tools throw
        // on bad input, but a Zod failure is a clearer error to relay.
        let parsedArgs: unknown
        try {
          parsedArgs = init.parameters.parse(args)
        } catch (err) {
          return `Error: arguments to '${name}' failed schema validation — ${err instanceof Error ? err.message : err}`
        }

        const abort = new AbortController()
        const ctx = {
          ...ctxBase,
          callID: `freerun-call-${Date.now()}`,
          extra: {},
          messages: [] as any[],
          abort: abort.signal,
          metadata: () => {},
          // Permission handling: auto-allow within freerun engine path.
          // The bash sudo gate + denylist still fire in the tool's own
          // execute(); this just stops the permission system from
          // blocking on "ask" rules when permissionMode is something
          // other than auto.
          async ask() {},
        } as any

        try {
          const result = await init.execute(parsedArgs as any, ctx)
          return result.output ?? ""
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          log.warn("tool execute threw", { tool: name, error: message })
          return `Error: ${name} failed — ${message}`
        }
      },
    } as any
  }

  // ============================================================================
  // Helpers
  // ============================================================================

  /** Extract a JSON Schema from a Zod schema for the OpenAI tool catalog. */
  function jsonSchemaFromZod(zodSchema: unknown): unknown {
    try {
      // Tools wrap their parameters via z.object; ai-sdk's asSchema gives us
      // the JSON Schema form we can send to the OpenAI-compatible endpoint.
      const wrapped = { inputSchema: zodSchema } as unknown as AITool
      const resolved = asSchema((wrapped as any).inputSchema)
      return resolved?.jsonSchema ?? { type: "object", properties: {} }
    } catch {
      return { type: "object", properties: {} }
    }
  }
}
