import z from "zod"
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

function extractSummary(description: string) {
  const firstLine = description.split("\n")[0].trim()
  const firstSentence = firstLine.match(/^[^.!]+[.!]?/)?.[0] ?? firstLine
  return firstSentence.slice(0, 120)
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
