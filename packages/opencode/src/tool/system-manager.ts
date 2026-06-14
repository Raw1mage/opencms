import z from "zod"

import { callSystemManagerTool, listSystemManagerTools } from "../../../mcp/system-manager/src/index"
import type { MessageV2 } from "../session/message-v2"
import { Tool } from "./tool"

type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "resource"; resource?: { text?: string; blob?: string; mimeType?: string; uri?: string } }

type JsonSchema = {
  type?: string
  description?: string
  enum?: unknown[]
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema
  minimum?: number
  maximum?: number
}

const SYSTEM_MANAGER_TOOL_NAMES = [
  "get_system_status",
  "switch_session",
  "switch_model",
  "switch_account",
  "switch_provider",
  "get_session",
  "get_favorites",
  "switch_theme",
  "toggle_mcp",
  "copy_to_clipboard",
  "execute_command",
  "update_models",
  "switch_agent",
  "open_in_editor",
  "open_fileview",
  "display_inline_image",
  "manage_session",
  "app_control",
  "set_ui_config",
  "export_transcript",
  "set_log_level",
  "list_subagents",
  "read_subsession",
  "install_mcp_app",
  "list_mcp_apps",
  "remove_mcp_app",
  "restart_self",
  "skill_loader",
] as const

function contentToOutput(content: McpContent[] | undefined) {
  const textParts: string[] = []
  const attachments: Omit<MessageV2.FilePart, "id" | "messageID" | "sessionID">[] = []

  for (const item of content ?? []) {
    if (item.type === "text") {
      textParts.push(item.text)
      continue
    }
    if (item.type === "image") {
      attachments.push({ type: "file", mime: item.mimeType, url: `data:${item.mimeType};base64,${item.data}` })
      continue
    }
    if (item.type === "resource") {
      if (item.resource?.text) textParts.push(item.resource.text)
      if (item.resource?.blob) {
        const mime = item.resource.mimeType ?? "application/octet-stream"
        attachments.push({
          type: "file",
          mime,
          url: `data:${mime};base64,${item.resource.blob}`,
          filename: item.resource.uri,
        })
      }
    }
  }

  return { output: textParts.join("\n\n"), attachments }
}

function scalarSchemaToZod(schema: JsonSchema | undefined): z.ZodTypeAny {
  if (!schema) return z.unknown()
  let result: z.ZodTypeAny
  if (Array.isArray(schema.enum) && schema.enum.every((item) => typeof item === "string") && schema.enum.length > 0) {
    result = z.enum(schema.enum as [string, ...string[]])
  } else if (schema.type === "integer") {
    result = z.number().int()
  } else if (schema.type === "number") {
    result = z.number()
  } else if (schema.type === "boolean") {
    result = z.boolean()
  } else if (schema.type === "array") {
    result = z.array(scalarSchemaToZod(schema.items))
  } else if (schema.type === "object") {
    result = jsonSchemaToZodObject(schema)
  } else {
    result = z.string()
  }
  if (typeof schema.minimum === "number" && result instanceof z.ZodNumber) result = result.min(schema.minimum)
  if (typeof schema.maximum === "number" && result instanceof z.ZodNumber) result = result.max(schema.maximum)
  return schema.description ? result.describe(schema.description) : result
}

function jsonSchemaToZodObject(schema: JsonSchema | undefined) {
  const properties = schema?.properties ?? {}
  const required = new Set(schema?.required ?? [])
  const shape: Record<string, z.ZodTypeAny> = {}
  for (const [key, value] of Object.entries(properties)) {
    const field = scalarSchemaToZod(value)
    shape[key] = required.has(key) ? field : field.optional()
  }
  return z.object(shape).passthrough()
}

function createSystemManagerTool(name: (typeof SYSTEM_MANAGER_TOOL_NAMES)[number]) {
  const id = `system-manager_${name}`
  return Tool.define(id, async () => {
    const listed = await listSystemManagerTools()
    const definition = listed.tools.find((item) => item.name === name)
    if (!definition) throw new Error(`system-manager tool definition missing: ${name}`)
    return {
      description: definition.description,
      parameters: jsonSchemaToZodObject(definition.inputSchema as JsonSchema),
      async execute(args) {
        const result = (await callSystemManagerTool(name, args)) as {
          content?: McpContent[]
          metadata?: Record<string, unknown>
          isError?: boolean
          structuredContent?: unknown
        }
        const { output, attachments } = contentToOutput(result.content)
        return {
          title: id,
          output,
          attachments,
          metadata: {
            direct: true,
            systemManagerTool: name,
            isError: result.isError === true,
            ...(result.metadata ?? {}),
            ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
          },
        }
      },
    }
  })
}

export const SystemManagerTools = SYSTEM_MANAGER_TOOL_NAMES.map(createSystemManagerTool)
