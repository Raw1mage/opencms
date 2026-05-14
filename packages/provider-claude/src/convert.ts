/**
 * LMv2 ↔ Anthropic format converters.
 *
 * Phase 1: Request converters (LMv2 → Anthropic) and response type helpers.
 * Does NOT depend on @ai-sdk/anthropic.
 */
import type {
  LanguageModelV2Prompt,
  LanguageModelV2FunctionTool,
} from "@ai-sdk/provider"
import {
  TOOL_PREFIX,
  BOUNDARY_MARKER,
  IDENTITY_INTERACTIVE,
  buildBillingHeader,
} from "./protocol.js"

// ---------------------------------------------------------------------------
// Anthropic API types (wire format)
// ---------------------------------------------------------------------------

export interface AnthropicMessage {
  role: "user" | "assistant"
  content: string | AnthropicContentBlock[]
}

export type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content?: string | AnthropicContentBlock[] }
  | { type: "thinking"; thinking: string }

export interface AnthropicSystemBlock {
  type: "text"
  text: string
  cache_control?: { type: "ephemeral"; scope?: "global" | "org"; ttl?: string } | null
}

export interface AnthropicTool {
  name: string
  description?: string
  input_schema: unknown
}

// ---------------------------------------------------------------------------
// § 1A.1  convertPrompt — LMv2 messages → Anthropic messages + system
// ---------------------------------------------------------------------------

export function convertPrompt(prompt: LanguageModelV2Prompt): {
  messages: AnthropicMessage[]
  system: string | undefined
} {
  let system: string | undefined
  const messages: AnthropicMessage[] = []

  for (const msg of prompt) {
    switch (msg.role) {
      case "system":
        // System messages are concatenated — the provider will wrap them in blocks later
        system = system ? `${system}\n\n${msg.content}` : msg.content
        break

      case "user": {
        const blocks: AnthropicContentBlock[] = []
        for (const part of msg.content) {
          if (part.type === "text") {
            blocks.push({ type: "text", text: part.text })
          } else if (part.type === "file") {
            // Image or file content
            if (typeof part.data === "string") {
              // base64 string
              blocks.push({
                type: "image",
                source: {
                  type: "base64",
                  media_type: part.mediaType,
                  data: part.data,
                },
              })
            } else if (part.data instanceof URL) {
              // URL — Anthropic supports url source type but we convert to text reference
              blocks.push({
                type: "text",
                text: `[File: ${part.data.toString()}]`,
              })
            } else {
              // Uint8Array → base64
              const b64 = Buffer.from(part.data).toString("base64")
              blocks.push({
                type: "image",
                source: {
                  type: "base64",
                  media_type: part.mediaType,
                  data: b64,
                },
              })
            }
          }
        }
        if (blocks.length > 0) {
          messages.push({ role: "user", content: blocks })
        }
        break
      }

      case "assistant": {
        const blocks: AnthropicContentBlock[] = []
        for (const part of msg.content) {
          if (part.type === "text") {
            blocks.push({ type: "text", text: part.text })
          } else if (part.type === "reasoning") {
            blocks.push({ type: "thinking", thinking: part.text })
          } else if (part.type === "tool-call") {
            const name = prefixToolName(part.toolName)
            blocks.push({
              type: "tool_use",
              id: part.toolCallId,
              name,
              input: typeof part.input === "string" ? safeParseJSON(part.input) : part.input,
            })
          }
          // file parts in assistant messages are ignored (not in Anthropic spec)
        }
        if (blocks.length > 0) {
          messages.push({ role: "assistant", content: blocks })
        }
        break
      }

      case "tool": {
        const blocks: AnthropicContentBlock[] = []
        for (const part of msg.content) {
          if (part.type === "tool-result") {
            const resultContent = formatToolResultOutput(part.output)
            blocks.push({
              type: "tool_result",
              tool_use_id: part.toolCallId,
              content: resultContent,
            })
          }
        }
        if (blocks.length > 0) {
          messages.push({ role: "user", content: blocks })
        }
        break
      }
    }
  }

  return { messages, system }
}

// ---------------------------------------------------------------------------
// § 1A.2  convertTools — LMv2 function tools → Anthropic tools
// ---------------------------------------------------------------------------

export function convertTools(
  tools: LanguageModelV2FunctionTool[] | undefined,
): AnthropicTool[] | undefined {
  if (!tools || tools.length === 0) return undefined

  return tools.map((tool) => ({
    name: prefixToolName(tool.name),
    description: tool.description,
    input_schema: tool.inputSchema,
  }))
}

// ---------------------------------------------------------------------------
// § 1A.3  convertSystemBlocks — system text + sections → Anthropic system blocks
// ---------------------------------------------------------------------------

export interface ConvertSystemOptions {
  /** Raw system text from convertPrompt */
  systemText: string | undefined
  /** Whether prompt caching is enabled */
  enableCaching: boolean
  /** Identity string to prepend */
  identity?: string
  /** Content for billing header hash (first user message text) */
  billingContent?: string
  /** Entrypoint for billing header */
  entrypoint?: string
}

export function convertSystemBlocks(options: ConvertSystemOptions): AnthropicSystemBlock[] {
  const {
    systemText,
    enableCaching,
    identity = IDENTITY_INTERACTIVE,
    billingContent,
    entrypoint,
  } = options

  const blocks: AnthropicSystemBlock[] = []

  // Block 0: billing header (no cache)
  if (billingContent) {
    const headerText = `x-anthropic-billing-header: ${buildBillingHeader(billingContent, entrypoint)}`
    blocks.push({ type: "text", text: headerText, cache_control: null })
  }

  // Block 1: identity (org-level cache)
  blocks.push({
    type: "text",
    text: identity,
    ...(enableCaching && { cache_control: { type: "ephemeral" as const, scope: "org" as const } }),
  })

  if (!systemText) return blocks

  // Check for boundary marker
  const boundaryIdx = systemText.indexOf(BOUNDARY_MARKER)

  if (boundaryIdx !== -1) {
    // Mode B: Boundary-based cache
    const staticPart = systemText.slice(0, boundaryIdx).trim()
    const dynamicPart = systemText.slice(boundaryIdx + BOUNDARY_MARKER.length).trim()

    if (staticPart) {
      blocks.push({
        type: "text",
        text: staticPart,
        ...(enableCaching && { cache_control: { type: "ephemeral" as const, scope: "global" as const } }),
      })
    }

    if (dynamicPart) {
      blocks.push({ type: "text", text: dynamicPart })
    }
  } else {
    // Mode C: Fallback — all sections as org-level cache
    blocks.push({
      type: "text",
      text: systemText,
      ...(enableCaching && { cache_control: { type: "ephemeral" as const, scope: "org" as const } }),
    })
  }

  // Filter out empty text blocks
  return blocks.filter((b) => b.text && b.text.trim() !== "")
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function prefixToolName(name: string): string {
  return name.startsWith(TOOL_PREFIX) ? name : `${TOOL_PREFIX}${name}`
}

export function stripToolPrefix(name: string): string {
  return name.startsWith(TOOL_PREFIX) ? name.slice(TOOL_PREFIX.length) : name
}

function safeParseJSON(input: unknown): unknown {
  if (typeof input !== "string") return input
  try {
    return JSON.parse(input)
  } catch {
    return input
  }
}

function formatToolResultOutput(output: unknown): string {
  if (!output || typeof output !== "object") return String(output ?? "")
  const o = output as { type?: string; value?: unknown }
  switch (o.type) {
    case "text":
    case "error-text":
      return String(o.value ?? "")
    case "json":
    case "error-json":
      return JSON.stringify(o.value)
    case "content": {
      const parts = o.value as Array<{ type: string; text?: string; data?: string }>
      return parts
        .map((p) => (p.type === "text" ? p.text : `[media:${p.data?.slice(0, 20)}...]`))
        .join("\n")
    }
    default:
      return JSON.stringify(output)
  }
}
