import z from "zod"
import { type Tool as AITool, tool, jsonSchema } from "ai"
import { Log } from "../util/log"
import { debugCheckpoint } from "@/util/debug"
import { ProviderTransform } from "../provider/transform"
import { ToolRegistry } from "../tool/registry"
import { MCP } from "../mcp"
import { Tool } from "@/tool/tool"
import { ToolInvoker } from "./tool-invoker"
import { PermissionNext } from "@/permission/next"
import { Session } from "."
import { Truncate } from "@/tool/truncation"
import { MessageV2 } from "./message-v2"
import { SessionProcessor } from "./processor"
import { Agent } from "../agent/agent"
import { Provider } from "../provider/provider"
import { Config } from "../config/config"
import ENABLEMENT from "./prompt/enablement.json"
import { UnlockedTools } from "./unlocked-tools"
import { ToolFrequency } from "../tool/frequency"
import { ALWAYS_PRESENT_TOOLS, buildCatalog, formatCatalogDescription } from "../tool/tool-loader"

const log = Log.create({ service: "session.resolve-tools" })

const AUTO_MCP_IDLE_MS = 10 * 60_000
const autoEnabledBySession = new Map<string, Map<string, number>>()

type EnablementRoute = {
  intent?: string
  keywords?: string[]
  requires_mcp?: string[]
}

function extractLatestUserText(messages: MessageV2.WithParts[]): string {
  const lastUser = [...messages].reverse().find((m) => m.info.role === "user")
  if (!lastUser) return ""
  return lastUser.parts
    .filter((p): p is MessageV2.TextPart => p.type === "text")
    .map((p) => p.text)
    .join("\n")
    .toLowerCase()
}

function inferDesiredMcpFromEnablement(text: string): Set<string> {
  const desired = new Set<string>()
  const routing = ((ENABLEMENT as any)?.routing?.intent_to_capability ?? []) as EnablementRoute[]
  for (const route of routing) {
    const keywords = route.keywords ?? []
    if (keywords.length === 0) continue
    if (keywords.some((kw) => text.includes(kw.toLowerCase()))) {
      for (const mcp of route.requires_mcp ?? []) desired.add(mcp)
    }
  }
  return desired
}

async function applyOnDemandMcpPolicy(sessionID: string, messages: MessageV2.WithParts[]) {
  const text = extractLatestUserText(messages)
  const desired = text ? inferDesiredMcpFromEnablement(text) : new Set<string>()

  const [cfg, status] = await Promise.all([Config.get(), MCP.status()])
  const mcpConfig = cfg.mcp ?? {}

  for (const name of desired) {
    if (!(name in mcpConfig)) continue
    if (status[name]?.status === "connected") {
      let tracking = autoEnabledBySession.get(sessionID)
      if (!tracking) {
        tracking = new Map<string, number>()
        autoEnabledBySession.set(sessionID, tracking)
      }
      tracking.set(name, Date.now())
      continue
    }

    try {
      await MCP.connect(name)
      let tracking = autoEnabledBySession.get(sessionID)
      if (!tracking) {
        tracking = new Map<string, number>()
        autoEnabledBySession.set(sessionID, tracking)
      }
      tracking.set(name, Date.now())
      log.info("on-demand MCP connected", { sessionID, name })
    } catch (error) {
      log.warn("on-demand MCP connect failed", {
        sessionID,
        name,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const tracking = autoEnabledBySession.get(sessionID)
  if (!tracking || tracking.size === 0) return
  const now = Date.now()
  for (const [name, lastNeededAt] of tracking.entries()) {
    if (desired.has(name)) {
      tracking.set(name, now)
      continue
    }
    if (now - lastNeededAt < AUTO_MCP_IDLE_MS) continue
    try {
      await MCP.disconnect(name)
      tracking.delete(name)
      log.info("on-demand MCP disconnected after idle", { sessionID, name })
    } catch (error) {
      log.warn("on-demand MCP disconnect failed", {
        sessionID,
        name,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  if (tracking.size === 0) autoEnabledBySession.delete(sessionID)
}

export interface ResolveToolsInput {
  agent: Agent.Info
  model: Provider.Model
  session: Session.Info
  tools?: Record<string, boolean>
  processor: SessionProcessor.Info
  bypassAgentCheck: boolean
  messages: MessageV2.WithParts[]
}

export async function resolveTools(input: ResolveToolsInput) {
  using _ = log.time("resolveTools")
  const tools: Record<string, AITool> = {}
  await applyOnDemandMcpPolicy(input.session.id, input.messages)
  debugCheckpoint("tool.resolve", "start", {
    sessionID: input.session.id,
    agent: input.agent.name,
    providerId: input.model.providerId,
    modelID: input.model.api.id,
    bypassAgentCheck: input.bypassAgentCheck,
    trace: input.session.id,
  })

  const ruleset = PermissionNext.merge(input.agent.permission, input.session.permission ?? [])
  const toolAllowed = (toolID: string) => PermissionNext.evaluate(toolID, "*", ruleset).action !== "deny"

  const registryTools = await ToolRegistry.tools(
    { modelID: input.model.api.id, providerId: input.model.providerId },
    input.agent,
  )
  debugCheckpoint("tool.resolve", "registry", {
    count: registryTools.length,
    ids: registryTools.map((item) => item.id),
    trace: input.session.id,
  })

  const seen = new Map<string, string | undefined>()
  for (const item of registryTools) {
    if (!toolAllowed(item.id)) continue
    const prev = seen.get(item.id)
    if (prev) {
      debugCheckpoint("tool.resolve", "duplicate", {
        id: item.id,
        previous: prev,
        next: item.source ?? "unknown",
        trace: input.session.id,
      })
    }
    seen.set(item.id, item.source)
    const schema = ProviderTransform.schema(input.model, z.toJSONSchema(item.parameters))

    tools[item.id] = tool({
      id: item.id as `${string}.${string}`,
      description: item.description,
      inputSchema: jsonSchema(schema as Record<string, unknown>),
      async execute(args, options) {
        return ToolInvoker.execute(item, {
          sessionID: input.session.id,
          messageID: input.processor.message.id,
          toolID: item.id,
          args,
          agent: input.agent.name,
          abort: options.abortSignal!,
          messages: input.messages,
          extra: { model: input.model, bypassAgentCheck: input.bypassAgentCheck },
          callID: options.toolCallId,
          onMetadata: async (val) => {
            const match = input.processor.partFromToolCall(options.toolCallId)
            if (match && match.state.status === "running") {
              await Session.updatePart({
                ...match,
                state: {
                  title: val.title,
                  metadata: val.metadata,
                  status: "running",
                  input: args,
                  time: {
                    start: Date.now(),
                  },
                },
              })
            }
          },
          onAsk: async (req) => {
            const effectiveRuleset = PermissionNext.merge(input.agent.permission, input.session.permission ?? [])
            await PermissionNext.ask({
              ...req,
              sessionID: input.session.id,
              tool: { messageID: input.processor.message.id, callID: options.toolCallId },
              ruleset: effectiveRuleset,
            })
          },
        })
      },
    })
  }

  for (const [key, item] of Object.entries(await MCP.tools())) {
    if (!toolAllowed(key)) continue
    const execute = item.execute
    if (!execute) continue

    item.execute = async (args, opts) => {
      const result = await ToolInvoker.execute(
        {
          execute: async (_args: unknown, ctx: Tool.Context) => {
            await ctx.ask({
              permission: key,
              metadata: {},
              patterns: ["*"],
              always: ["*"],
            })
            return execute(args, opts)
          },
        },
        {
          sessionID: input.session.id,
          messageID: input.processor.message.id,
          toolID: key,
          args,
          agent: input.agent.name,
          abort: opts.abortSignal!,
          messages: input.messages,
          extra: { model: input.model, bypassAgentCheck: input.bypassAgentCheck },
          callID: opts.toolCallId,
          onAsk: async (req) => {
            await PermissionNext.ask({
              ...req,
              sessionID: input.session.id,
              tool: { messageID: input.processor.message.id, callID: opts.toolCallId },
              ruleset,
            })
          },
        },
      )

      const textParts: string[] = []
      const attachments: Omit<MessageV2.FilePart, "id" | "messageID" | "sessionID">[] = []

      for (const contentItem of result.content) {
        if (contentItem.type === "text") {
          textParts.push(contentItem.text)
        } else if (contentItem.type === "image") {
          attachments.push({
            type: "file",
            mime: contentItem.mimeType,
            url: `data:${contentItem.mimeType};base64,${contentItem.data}`,
          })
        } else if (contentItem.type === "resource") {
          const { resource } = contentItem
          if (resource.text) {
            textParts.push(resource.text)
          }
          if (resource.blob) {
            attachments.push({
              type: "file",
              mime: resource.mimeType ?? "application/octet-stream",
              url: `data:${resource.mimeType ?? "application/octet-stream"};base64,${resource.blob}`,
              filename: resource.uri,
            })
          }
        }
      }

      const truncated = await Truncate.output(textParts.join("\n\n"), {}, input.agent, input.session.id)
      const metadata = {
        ...(result.metadata ?? {}),
        truncated: truncated.truncated,
        ...(truncated.truncated && { outputPath: truncated.outputPath }),
      }

      return {
        title: "",
        metadata,
        output: truncated.content,
        attachments,
        content: result.content,
      }
    }

    tools[key] = item
  }

  const config = await Config.get()
  const lazyConfig = config.experimental?.lazy_tools
  const lazyEnabled = lazyConfig?.enabled !== false

  if (lazyEnabled && input.agent.mode !== "subagent") {
    const alwaysPresent = new Set(ALWAYS_PRESENT_TOOLS)
    for (const id of lazyConfig?.always_present ?? []) alwaysPresent.add(id)

    const threshold = lazyConfig?.promotion_threshold ?? 50
    const promotedTools = await ToolFrequency.promoted(threshold)
    for (const id of promotedTools) alwaysPresent.add(id)

    const unlocked = UnlockedTools.get(input.session.id)
    const allToolEntries = Object.entries(tools).map(([id, tool]) => ({
      id,
      description: ((tool as any).description ?? "") as string,
    }))
    const frequencyScores = await ToolFrequency.scores()
    const catalog = buildCatalog(allToolEntries, frequencyScores)
    const lazyToolCount = allToolEntries.filter((tool) => !alwaysPresent.has(tool.id)).length

    if (tools["tool_loader"]) {
      ;(tools["tool_loader"] as any).description = formatCatalogDescription(catalog, lazyToolCount)
    }

    for (const id of Object.keys(tools)) {
      if (!alwaysPresent.has(id) && !unlocked.has(id)) delete tools[id]
    }

    debugCheckpoint("tool.resolve", "lazy-filter", {
      alwaysPresent: [...alwaysPresent],
      promoted: promotedTools,
      unlocked: [...unlocked],
      catalogSize: catalog.length,
      removedCount: allToolEntries.length - Object.keys(tools).length,
      trace: input.session.id,
    })
  }

  const ids = Object.keys(tools)
  debugCheckpoint("tool.resolve", "ready", {
    count: ids.length,
    ids,
    hasGoogleSearch: ids.includes("google_search"),
    trace: input.session.id,
  })

  return tools
}
