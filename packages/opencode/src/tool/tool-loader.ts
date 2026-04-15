import z from "zod"
import { asSchema, type Tool as AITool } from "@ai-sdk/provider-utils"
import { Tool } from "./tool"
import { UnlockedTools } from "../session/unlocked-tools"
import { Log } from "../util/log"

const log = Log.create({ service: "tool.tool-loader" })
const CATALOG_MAX_ENTRIES = 50

export const ALWAYS_PRESENT_TOOLS = new Set([
  "task",
  "question",
  "read",
  "todowrite",
  "todoread",
  "tool_loader",
  "invalid",
])

export interface CatalogEntry {
  id: string
  summary: string
}

function extractSummary(description: string, maxLen = 120) {
  const firstLine = description.split("\n")[0].trim()
  const firstSentence = firstLine.match(/^[^.!]+[.!]?/)?.[0] ?? firstLine
  return firstSentence.slice(0, maxLen)
}

function extractExtendedSummary(description: string) {
  // Up to 2 sentences or 200 chars — richer than catalog but still compact
  const lines = description.split("\n").filter((l) => l.trim())
  const text = lines.slice(0, 2).join(" ").trim()
  const match = text.match(/^(?:[^.!?]+[.!?]\s?){1,2}/)
  return (match?.[0] ?? text).slice(0, 200)
}

/**
 * Extract a compact parameter signature from a tool's inputSchema.
 * e.g. "(input: string)" or "(command: string, timeout?: number)"
 */
function extractParamSignature(tool: unknown): string {
  try {
    const schema = (tool as AITool)?.inputSchema
    if (!schema) return ""
    const resolved = asSchema(schema)
    const jsonSch = resolved?.jsonSchema as Record<string, unknown> | undefined
    if (!jsonSch || jsonSch.type !== "object") return ""
    const props = jsonSch.properties as Record<string, { type?: string; description?: string }> | undefined
    if (!props) return ""
    const required = new Set((jsonSch.required as string[]) ?? [])
    const parts: string[] = []
    for (const [name, prop] of Object.entries(props)) {
      const opt = required.has(name) ? "" : "?"
      const type = prop.type ?? "any"
      parts.push(`${name}${opt}: ${type}`)
    }
    return parts.length > 0 ? `(${parts.join(", ")})` : ""
  } catch {
    return ""
  }
}

export function buildCatalog(allTools: { id: string; description: string }[], scores: Record<string, number>) {
  return allTools
    .filter((tool) => !ALWAYS_PRESENT_TOOLS.has(tool.id))
    .map((tool) => ({
      id: tool.id,
      summary: extractSummary(tool.description),
      score: scores[tool.id] ?? 0,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, CATALOG_MAX_ENTRIES)
    .map(({ id, summary }) => ({ id, summary }))
}

export function formatCatalogDescription(catalog: CatalogEntry[], totalAvailable: number) {
  const lines = [
    "Load additional tools into this session. Call with the tool names you need — they become available on your next action.",
    "",
    "## Available Tools",
    "",
  ]
  for (const entry of catalog) lines.push(`- **${entry.id}**: ${entry.summary}`)
  if (totalAvailable > catalog.length) lines.push(`- ...and ${totalAvailable - catalog.length} more — specify by name`)
  lines.push("")
  lines.push('Pass tool names as an array: tool_loader({ tools: ["bash", "edit"] })')
  return lines.join("\n")
}

/**
 * Build a compact system-prompt section (~2-4K tokens) that tells the AI
 * what deferred tools exist so it can call them directly.  The LLM runtime
 * will auto-load any deferred tool on first call via `experimental_repairToolCall`.
 */
export function formatLazyCatalogPrompt(
  lazyTools: Map<string, { description?: string }>,
): string | undefined {
  if (!lazyTools || lazyTools.size === 0) return undefined

  // Categorise by prefix convention
  const categories: Record<string, { id: string; summary: string }[]> = {}
  for (const [id, def] of lazyTools) {
    const desc = (def as any).description ?? ""
    const summary = extractExtendedSummary(desc)
    // Derive category from prefix: mcp__xxx → MCP/xxx, mcpapp-xxx → App/xxx, else Built-in
    let cat: string
    if (id.startsWith("mcp__")) {
      const server = id.split("__")[1] ?? "unknown"
      cat = `MCP: ${server}`
    } else if (id.startsWith("mcpapp-")) {
      const app = id.split("-")[1]?.split("_")[0] ?? "unknown"
      cat = `App: ${app}`
    } else {
      cat = "Built-in"
    }
    if (!categories[cat]) categories[cat] = []
    categories[cat].push({ id, summary })
  }

  const lines: string[] = [
    "<deferred-tools>",
    `The following ${lazyTools.size} tools are available on-demand. You can call any of them directly — they will be auto-loaded on first use. No need to call tool_loader first.`,
    "",
  ]

  // Sort categories: Built-in first, then alphabetical
  const sortedCats = Object.keys(categories).sort((a, b) => {
    if (a === "Built-in") return -1
    if (b === "Built-in") return 1
    return a.localeCompare(b)
  })

  for (const cat of sortedCats) {
    const entries = categories[cat]
    lines.push(`### ${cat}`)
    for (const entry of entries) {
      const sig = extractParamSignature(lazyTools.get(entry.id))
      lines.push(`- **${entry.id}**${sig}: ${entry.summary}`)
    }
    lines.push("")
  }

  lines.push("</deferred-tools>")
  return lines.join("\n")
}

export const ToolLoaderTool = Tool.define("tool_loader", async () => ({
  description: "Load additional tools into this session. Use this to unlock tools not currently available.",
  parameters: z.object({
    tools: z.array(z.string()).min(1).describe("Tool names to load from the catalog"),
  }),
  async execute(args, ctx) {
    log.info("tool_loader invoked", { sessionID: ctx.sessionID, requested: args.tools })
    UnlockedTools.unlock(ctx.sessionID, args.tools)
    return {
      title: `Loaded ${args.tools.length} tool(s)`,
      metadata: { truncated: false as const },
      output: `Loaded tools: ${args.tools.join(", ")}. They are available on your next action.`,
    }
  },
}))
