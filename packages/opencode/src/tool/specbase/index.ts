/**
 * specbase native tool layer (dual-track, DD-5/DD-6 of
 * specbase/internal-toolcall-dual-track).
 *
 * opencode consumes specbase IN-PROCESS: it imports the single-source
 * TOOL_DEFINITIONS from @specbase/lib and registers each as a native
 * ToolRegistry tool (id `specbase_<name>`, preserved from the old MCP path so
 * AGENTS.md references and agent habits don't break). No stdio MCP child, no
 * tool-surface drift — the MCP server (@specbase/mcp) keeps serving external
 * hosts from the SAME definitions.
 */
import { z } from "zod"
import { resolve } from "node:path"
import { Tool } from "../tool"
import { Instance } from "../../project/instance"
import { TOOL_DEFINITIONS, type ToolCtx, type ToolResult } from "@specbase/lib/tools"

// Minimal JSON-Schema → zod for the property shapes specbase tools use
// (string / number / boolean / array-of-string / string-enum). The tool's
// inputSchema is the single source; this only re-expresses it as zod so the
// native registry can advertise parameters the same way built-in tools do.
function propToZod(p: Record<string, any>): z.ZodTypeAny {
  if (Array.isArray(p.enum) && p.enum.length > 0) {
    return z.enum(p.enum as [string, ...string[]])
  }
  switch (p.type) {
    case "string":
      return z.string()
    case "number":
      return z.number()
    case "boolean":
      return z.boolean()
    case "array":
      return z.array(p.items?.type === "string" ? z.string() : z.any())
    default:
      return z.any()
  }
}

function inputSchemaToZod(schema: Record<string, any>): z.ZodObject<any> {
  const props = (schema.properties ?? {}) as Record<string, Record<string, any>>
  const required = new Set<string>(Array.isArray(schema.required) ? schema.required : [])
  const shape: Record<string, z.ZodTypeAny> = {}
  for (const [key, prop] of Object.entries(props)) {
    let zt = propToZod(prop)
    if (typeof prop.description === "string") zt = zt.describe(prop.description)
    if (!required.has(key)) zt = zt.optional()
    shape[key] = zt
  }
  return z.object(shape)
}

// Parity with the MCP adapter's defaultRepo()/defaultLang(): honour a per-call
// `repo`, then SPECBASE_TARGET_REPO, else the active project directory
// (Instance.directory is opencode's in-process equivalent of process.cwd()).
function resolveCtx(args: Record<string, unknown>): ToolCtx {
  const envRepo = process.env.SPECBASE_TARGET_REPO?.trim()
  const repo =
    typeof args.repo === "string" && args.repo
      ? resolve(args.repo)
      : envRepo
        ? resolve(envRepo)
        : Instance.directory
  const lang = process.env.SPECBASE_PRIMARY_LANG?.trim() || "zh-Hant"
  return { repo, lang }
}

function formatOutput(result: ToolResult): string {
  if (result.ok) return JSON.stringify(result.data, null, 2)
  return JSON.stringify({ error: result.error, detail: result.detail }, null, 2)
}

export const SpecbaseTools: Tool.Info[] = TOOL_DEFINITIONS.map((def) => ({
  id: `specbase_${def.name}`,
  source: "specbase-native",
  init: async () => ({
    description: def.description,
    parameters: inputSchemaToZod(def.inputSchema),
    async execute(args: Record<string, unknown>) {
      const result = await def.handler(args ?? {}, resolveCtx(args ?? {}))
      return {
        title: def.name,
        metadata: { ok: result.ok },
        output: formatOutput(result),
      }
    },
  }),
}))
