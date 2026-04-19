import { QuestionTool } from "./question"
import { BashTool } from "./bash"
import { EditTool } from "./edit"
import { GlobTool } from "./glob"
import { GrepTool } from "./grep"
import { BatchTool } from "./batch"
import { ReadTool } from "./read"
import { TaskTool } from "./task"
import { TodoWriteTool, TodoReadTool } from "./todo"
import { WebFetchTool } from "./webfetch"
import { WriteTool } from "./write"
import { InvalidTool } from "./invalid"
import { SkillTool } from "./skill"
import type { Agent } from "../agent/agent"
import { Tool } from "./tool"
import { Instance } from "../project/instance"
import { Config } from "../config/config"
import path from "path"
import { type ToolContext as PluginToolContext, type ToolDefinition } from "@opencode-ai/plugin"
import z from "zod"
import { Plugin } from "../plugin"
import { WebSearchTool } from "./websearch"
import { CodeSearchTool } from "./codesearch"
import { Flag } from "@/flag/flag"
import { Log } from "@/util/log"
import { debugCheckpoint } from "@/util/debug"
import { LspTool } from "./lsp"
import { Truncate } from "./truncation"
import { ApplyPatchTool } from "./apply_patch"
import { CronCreateTool, CronListTool, CronDeleteTool } from "./cron"
import { RefreshCapabilityLayerTool } from "./refresh-capability-layer"
import { ToolLoaderTool } from "./tool-loader"
import { pathToFileURL } from "url"

export namespace ToolRegistry {
  const log = Log.create({ service: "tool.registry" })

  async function createState() {
    const custom = [] as Tool.Info[]
    const glob = new Bun.Glob("{tool,tools}/*.{js,ts}")

    for (const dir of await Config.directories()) {
      for await (const match of glob.scan({
        cwd: dir,
        absolute: true,
        followSymlinks: true,
        dot: true,
      })) {
        const namespace = path.basename(match, path.extname(match))
        const mod = await import(pathToFileURL(match).href)
        for (const [id, def] of Object.entries<ToolDefinition>(mod)) {
          custom.push(fromPlugin(id === "default" ? namespace : `${namespace}_${id}`, def, `file:${match}`))
        }
      }
    }

    const plugins = await Plugin.list()
    for (const plugin of plugins) {
      const source = "__source" in plugin ? (plugin as { __source?: string }).__source : undefined
      for (const [id, def] of Object.entries(plugin.tool ?? {})) {
        custom.push(fromPlugin(id, def, source ?? "plugin"))
      }
    }

    debugCheckpoint("tool.registry", "state: custom tools", {
      count: custom.length,
      tools: custom.map((item) => ({ id: item.id, source: item.source })),
    })

    return { custom }
  }

  let stateGetter: (() => Promise<Awaited<ReturnType<typeof createState>>>) | undefined
  let fallbackState: Promise<Awaited<ReturnType<typeof createState>>> | undefined

  export function state() {
    if (typeof Instance.state === "function") {
      stateGetter ||= Instance.state(createState)
      return stateGetter()
    }

    fallbackState ||= createState()
    return fallbackState
  }

  function fromPlugin(id: string, def: ToolDefinition, source?: string): Tool.Info {
    type PluginArgs = z.infer<z.ZodObject<typeof def.args>>
    return {
      id,
      source,
      init: async (initCtx) => ({
        parameters: z.object(def.args),
        description: def.description,
        execute: async (args, ctx) => {
          if (id === "google_search") {
            debugCheckpoint("tool.registry", "execute: google_search", {
              id,
              source,
            })
          }
          const pluginCtx = {
            ...ctx,
            directory: Instance.directory,
            worktree: Instance.worktree,
          } as unknown as PluginToolContext
          const result = await def.execute(args as PluginArgs, pluginCtx)
          const out = await Truncate.output(result, {}, initCtx?.agent, ctx.sessionID)
          return {
            title: "",
            output: out.truncated ? out.content : result,
            metadata: { truncated: out.truncated, outputPath: out.truncated ? out.outputPath : undefined },
          }
        },
      }),
    }
  }

  export async function register(tool: Tool.Info) {
    const { custom } = await state()
    const idx = custom.findIndex((t) => t.id === tool.id)
    if (idx >= 0) {
      custom.splice(idx, 1, tool)
      return
    }
    custom.push(tool)
  }

  async function all(): Promise<Tool.Info[]> {
    const custom = await state().then((x) => x.custom)
    const config = await Config.get()
    const question = ["app", "cli", "desktop"].includes(Flag.OPENCODE_CLIENT) || Flag.OPENCODE_ENABLE_QUESTION_TOOL

    return [
      InvalidTool,
      ...(question ? [QuestionTool] : []),
      BashTool,
      ReadTool,
      GlobTool,
      GrepTool,
      EditTool,
      WriteTool,
      TaskTool,
      WebFetchTool,
      TodoWriteTool,
      TodoReadTool,
      WebSearchTool,
      CodeSearchTool,
      SkillTool,
      ToolLoaderTool,
      ApplyPatchTool,
      CronCreateTool,
      CronListTool,
      CronDeleteTool,
      RefreshCapabilityLayerTool,
      ...(Flag.OPENCODE_EXPERIMENTAL_LSP_TOOL ? [LspTool] : []),
      ...(config.experimental?.batch_tool === true ? [BatchTool] : []),
      ...custom,
    ]
  }

  export async function ids() {
    return all().then((x) => x.map((t) => t.id))
  }

  const parametersCache = new Map<string, z.ZodType>()

  export async function getParameters(id: string): Promise<z.ZodType | undefined> {
    const cached = parametersCache.get(id)
    if (cached) return cached
    const tools = await all()
    const tool = tools.find((t) => t.id === id)
    if (!tool) return undefined
    const info = await tool.init()
    parametersCache.set(id, info.parameters)
    return info.parameters
  }

  export async function tools(
    model: {
      providerId: string
      modelID: string
    },
    agent?: Agent.Info,
  ) {
    debugCheckpoint("tool.registry", "tools: start", {
      providerId: model.providerId,
      modelID: model.modelID,
      agent: agent?.name,
    })
    const tools = await all()
    debugCheckpoint("tool.registry", "tools: all", {
      count: tools.length,
      ids: tools.map((item) => item.id),
    })
    const filtered = tools.filter((t) => {
      if (t.id === "google_search") return false
      // Enable websearch/codesearch for zen users OR via enable flag
      if (t.id === "codesearch" || t.id === "websearch") {
        return model.providerId === "opencode" || Flag.OPENCODE_ENABLE_EXA
      }

      // use apply tool in same format as codex
      const usePatch =
        model.modelID.includes("gpt-") && !model.modelID.includes("oss") && !model.modelID.includes("gpt-4")
      if (t.id === "apply_patch") return usePatch
      if (t.id === "edit" || t.id === "write") return !usePatch

      return true
    })
    debugCheckpoint("tool.registry", "tools: filtered", {
      count: filtered.length,
      ids: filtered.map((item) => item.id),
    })

    const score = (item: Tool.Info) => {
      if (item.source?.startsWith("internal:")) return 3
      if (item.source?.startsWith("file:")) return 1
      return 2
    }

    const groups = filtered.reduce<Record<string, Tool.Info[]>>((acc, item) => {
      acc[item.id] = acc[item.id] ? [...acc[item.id], item] : [item]
      return acc
    }, {})

    const deduped: Tool.Info[] = []
    const duplicates: { id: string; count: number; sources: string[]; chosen?: string }[] = []
    for (const [id, items] of Object.entries(groups)) {
      if (items.length === 1) {
        deduped.push(items[0])
        continue
      }
      const picked = items.reduce((current, item) => {
        if (score(item) > score(current)) return item
        return current
      })
      const sources = items.map((item) => item.source ?? "unknown")
      const chosen = picked.source ?? "unknown"
      duplicates.push({ id, count: items.length, sources, chosen })
      log.warn("duplicate tool id detected", { id, chosen, sources })
      deduped.push(picked)
    }

    if (duplicates.length > 0) {
      debugCheckpoint("tool.registry", "tools: duplicate ids", {
        duplicates,
      })
    }

    const result = await Promise.all(
      deduped.map(async (t) => {
        using _ = log.time(t.id)
        const tool = await t.init({ agent })
        const output = {
          description: tool.description,
          parameters: tool.parameters,
        }
        await Plugin.trigger("tool.definition", { toolID: t.id }, output)
        return {
          id: t.id,
          source: t.source,
          ...tool,
          description: output.description,
          parameters: output.parameters,
        }
      }),
    )
    debugCheckpoint("tool.registry", "tools: ready", {
      count: result.length,
      ids: result.map((item) => item.id),
    })
    return result
  }
}
