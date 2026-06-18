import z from "zod"
import { asSchema, type Tool as AITool } from "@ai-sdk/provider-utils"
import { Tool } from "./tool"
import { UnlockedTools } from "../session/unlocked-tools"
import { Log } from "../util/log"

const log = Log.create({ service: "tool.tool-loader" })
const CATALOG_MAX_ENTRIES = 50
const PRIORITY_CATALOG_TOOLS = new Set(["skill"])

export const ALWAYS_PRESENT_TOOLS = new Set([
  "task",
  "question",
  "read",
  "todowrite",
  "todoread",
  "tool_loader",
  "invalid",
  // Core execution primitives. Any code-touching agent needs these on
  // every turn; making them lazy forces an extra tool_loader hop and
  // tends to trap the model in todo-juggling when it actually wants
  // to run a command.
  "bash",
  "apply_patch",
  "grep",
  "glob",
  // Self-memory recall. Must be always-present so a post-compaction /
  // post-rotation / post-amnesia-anchor agent can query its own
  // history without first having to discover the tool exists.
  "session_recall",
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

export function buildCatalog(allTools: { id: string; description: string }[]) {
  const entries = allTools
    .filter((tool) => !ALWAYS_PRESENT_TOOLS.has(tool.id))
    .map((tool) => ({ id: tool.id, summary: extractSummary(tool.description) }))
    .sort((a, b) => a.id.localeCompare(b.id))

  const priority = entries.filter((tool) => PRIORITY_CATALOG_TOOLS.has(tool.id))
  const regular = entries.filter((tool) => !PRIORITY_CATALOG_TOOLS.has(tool.id))

  return [...priority, ...regular].slice(0, CATALOG_MAX_ENTRIES)
}

function normalizeToolAlias(name: string) {
  return name.trim().replace(/[:.]/g, "_")
}

function appAliasPrefix(name: string) {
  const normalized = name.trim()
  if (!normalized || normalized.includes("_") || normalized.includes(":")) return undefined
  return `${normalized}_`
}

export interface ToolLoaderResolution {
  found: string[]
  notFound: string[]
  aliases: Array<{ requested: string; resolved: string[] }>
  ambiguous: Array<{ requested: string; candidates: string[] }>
}

export function resolveToolLoaderRequest(available: Set<string>, requested: string[]): ToolLoaderResolution {
  const found = new Set<string>()
  const notFound: string[] = []
  const aliases: ToolLoaderResolution["aliases"] = []
  const ambiguous: ToolLoaderResolution["ambiguous"] = []
  const availableList = [...available].sort((a, b) => a.localeCompare(b))

  for (const rawName of requested) {
    const name = rawName.trim()
    if (!name) {
      notFound.push(rawName)
      continue
    }

    if (available.has(name)) {
      found.add(name)
      continue
    }

    const normalized = normalizeToolAlias(name)
    if (normalized !== name && available.has(normalized)) {
      found.add(normalized)
      aliases.push({ requested: name, resolved: [normalized] })
      continue
    }

    const prefix = appAliasPrefix(name)
    if (prefix) {
      const expanded = availableList.filter((id) => id.startsWith(prefix))
      if (expanded.length > 0) {
        for (const id of expanded) found.add(id)
        aliases.push({ requested: name, resolved: expanded })
        continue
      }
    }

    const suffixCandidates = availableList.filter((id) => id.endsWith(`_${normalized}`))
    if (suffixCandidates.length === 1) {
      found.add(suffixCandidates[0])
      aliases.push({ requested: name, resolved: [suffixCandidates[0]] })
      continue
    }
    if (suffixCandidates.length > 1) {
      ambiguous.push({ requested: name, candidates: suffixCandidates })
      notFound.push(name)
      continue
    }

    notFound.push(name)
  }

  return { found: [...found], notFound, aliases, ambiguous }
}

// DD-21: STATIC tool_loader description for the cached tools block. The live,
// per-unlock-changing catalog goes to the UNCACHED preface tail via
// formatLazyCatalogPrompt — it must NOT be baked into the tool definition (which
// sits in the cached tools→system→messages prefix), or every lazy unlock would
// churn the whole prefix → full rd=0 cold. This string never changes.
export const TOOL_LOADER_STATIC_DESCRIPTION =
  "Compatibility shim — usually unnecessary. The deferred tools listed in your context (the lazy-tool catalog) " +
  "are ALREADY directly callable: just call one and it auto-loads on first use. " +
  "Use this only to confirm a name resolves (e.g. an app/namespace alias) before calling it; " +
  'pass tool names as an array: tool_loader({ tools: ["bash", "edit"] }). It does not gate callability.'

// Retained for any caller still wanting the inline catalog; the active tool_loader
// path uses TOOL_LOADER_STATIC_DESCRIPTION instead (DD-21).
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
export function formatLazyCatalogPrompt(lazyTools: Map<string, { description?: string }>): string | undefined {
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

/**
 * Build the user/AI-facing output for a tool_loader resolution.
 *
 * Active Loader (DD-21): deferred tools are NEVER promoted into the wire
 * tools[] set — resolveTools keeps the cached prefix byte-immutable and the
 * real unlock happens request-locally via experimental_repairToolCall when the
 * model CALLS the tool. So tool_loader does not gate callability; the tools in
 * the <deferred-tools> catalog are already directly callable. This output must
 * therefore NOT claim "available on your next action" (the old wording was a
 * lie that made agents wait a turn for a callable that never arrives — see
 * issues/issue_20260617_tool_loader_loaded_tool_not_callable.md). Pulled out as
 * a pure function so the messaging contract is regression-testable without a ctx.
 *
 * Terminal-message contract (DD-1, anti-perseveration): for found tools the
 * output is callable-now AND terminal — it tells the model to stop calling
 * tool_loader and invoke the real tool directly, instead of the old encouraging
 * "call them directly now" phrasing that a post-compaction model re-read as a
 * setup step and looped on (see
 * issues/bug_20260618_post_compaction_tool_loader_perseveration_noop_shim.md).
 */
export function formatLoaderOutput(resolution: ToolLoaderResolution): { title: string; output: string } {
  const { found, notFound, aliases, ambiguous } = resolution
  const lines: string[] = []
  if (found.length > 0) {
    lines.push(
      `These tools are already directly callable — invoke ${found.join(", ")} now with real arguments. ` +
        "tool_loader is a NO-OP for them and was unnecessary; do NOT call tool_loader again — just call the tool.",
    )
  }
  for (const alias of aliases) {
    lines.push(`Resolved alias ${alias.requested} → ${alias.resolved.join(", ")}.`)
  }
  for (const item of ambiguous) {
    lines.push(`Ambiguous tool alias ${item.requested}; candidates: ${item.candidates.join(", ")}.`)
  }
  if (notFound.length > 0) {
    lines.push(
      `ERROR — tools not found: ${notFound.join(", ")}. ` +
        "These tools do not exist in the current tool pool. " +
        "Possible causes: the MCP server providing them is not connected, " +
        "the tool name is misspelled, or the tool is not registered. " +
        "Check MCP server status and tool catalog before retrying.",
    )
  }

  const allFailed = found.length === 0
  return {
    title: allFailed
      ? `Failed to load ${notFound.length} tool(s)`
      : `${found.length} tool(s) ready${notFound.length > 0 ? `, ${notFound.length} not found` : ""}`,
    output: lines.join("\n"),
  }
}

export const ToolLoaderTool = Tool.define("tool_loader", async () => ({
  description: "Load additional tools into this session. Use this to unlock tools not currently available.",
  parameters: z.object({
    tools: z.array(z.string()).min(1).describe("Tool names to load from the catalog"),
  }),
  async execute(args, ctx) {
    log.info("tool_loader invoked", { sessionID: ctx.sessionID, requested: args.tools })
    const available = UnlockedTools.getAvailable(ctx.sessionID)
    const { found, notFound, aliases, ambiguous } = resolveToolLoaderRequest(available, args.tools)

    if (found.length > 0) {
      UnlockedTools.unlock(ctx.sessionID, found)
    }

    if (notFound.length > 0) {
      log.warn("tool_loader: requested tools not in available pool", {
        sessionID: ctx.sessionID,
        notFound,
        availableCount: available.size,
      })
    }

    return {
      ...formatLoaderOutput({ found, notFound, aliases, ambiguous }),
      metadata: { truncated: false as const },
    }
  },
}))
