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

import { ToolRegistry } from "../../tool/registry"
import { ALWAYS_PRESENT_TOOLS } from "../../tool/tool-loader"
import { Log } from "../../util/log"
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
  const FREERUN_DEFAULT_TOOL_NAMES = new Set<string>([
    ...Array.from(ALWAYS_PRESENT_TOOLS),
    "write",
    "edit",
  ])
  FREERUN_DEFAULT_TOOL_NAMES.delete("task")
  FREERUN_DEFAULT_TOOL_NAMES.delete("cancel_task")
  FREERUN_DEFAULT_TOOL_NAMES.delete("question")
  FREERUN_DEFAULT_TOOL_NAMES.delete("invalid") // exposed only as model-redirect fallback

  /** Build the tool catalog (shapes consumed by Iterate / ToolFilter). */
  export async function buildCatalog(): Promise<ToolFilter.ToolRecord[]> {
    const all = await ToolRegistry.all()
    const out: ToolFilter.ToolRecord[] = []
    for (const t of all) {
      if (!FREERUN_DEFAULT_TOOL_NAMES.has(t.id)) continue
      const init = await t.init().catch(() => null)
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
    const all = await ToolRegistry.all()
    const lines: string[] = ["<freerun-tool-catalog>"]
    const sorted = all.slice().sort((a, b) => a.id.localeCompare(b.id))
    for (const t of sorted) {
      if (!FREERUN_DEFAULT_TOOL_NAMES.has(t.id)) continue
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
        const all = await ToolRegistry.all()
        const tool = all.find((t) => t.id === name)
        if (!tool) {
          const reason = `tool '${name}' not found in registry`
          log.warn(reason, { sessionID: opts.sessionID })
          return `Error: ${reason}.`
        }
        if (!FREERUN_DEFAULT_TOOL_NAMES.has(name)) {
          // Tool exists but not in freerun's default set → not unlocked.
          // The model should have used tool_loader first; bounce with a
          // helpful error that suggests it.
          return `Error: tool '${name}' is not unlocked for this freerun session. ` +
            `Call tool_loader with {"tools": ["${name}"]} first, then retry.`
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
