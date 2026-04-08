/**
 * LMv2 ↔ Responses API format converters.
 *
 * Converts AI SDK LanguageModelV2Prompt into Responses API
 * `instructions` (top-level) + `input` (ResponseItem[]).
 */
import type {
  LanguageModelV2Prompt,
  LanguageModelV2FunctionTool,
  LanguageModelV2Content,
} from "@ai-sdk/provider"
import type { ResponseItem, ContentPart } from "./types.js"

// ---------------------------------------------------------------------------
// § 1  convertPrompt — LMv2 prompt → instructions + input
// ---------------------------------------------------------------------------

export function convertPrompt(prompt: LanguageModelV2Prompt): {
  instructions: string
  input: ResponseItem[]
} {
  let instructions = ""
  const input: ResponseItem[] = []

  for (const msg of prompt) {
    switch (msg.role) {
      case "system":
        // System/developer messages become top-level `instructions`
        instructions = instructions ? `${instructions}\n\n${msg.content}` : msg.content
        break

      case "user": {
        const parts = convertUserContent(msg.content)
        if (parts.length === 1 && parts[0].type === "input_text") {
          input.push({ role: "user", content: (parts[0] as { text: string }).text })
        } else {
          input.push({ role: "user", content: parts })
        }
        break
      }

      case "assistant": {
        const parts = convertAssistantContent(msg.content)
        if (parts.textParts.length > 0 || parts.toolCalls.length > 0) {
          // Add assistant text
          if (parts.textParts.length > 0) {
            const text = parts.textParts.join("")
            input.push({ role: "assistant", content: text })
          }
          // Add tool calls as separate items
          for (const tc of parts.toolCalls) {
            input.push({
              type: "function_call",
              call_id: tc.toolCallId,
              name: tc.toolName,
              arguments: typeof tc.args === "string" ? tc.args : JSON.stringify(tc.args ?? {}),
            })
          }
        }
        break
      }

      case "tool": {
        // Tool results
        for (const result of msg.content) {
          input.push({
            type: "function_call_output",
            call_id: result.toolCallId,
            output: result.result == null
              ? ""
              : typeof result.result === "string"
                ? result.result
                : JSON.stringify(result.result),
          })
        }
        break
      }
    }
  }

  if (!instructions) {
    instructions = "You are a helpful assistant."
  }

  return { instructions, input }
}

// ---------------------------------------------------------------------------
// § 2  convertTools — LMv2 function tools → Responses API tools
// ---------------------------------------------------------------------------

export function convertTools(
  tools: LanguageModelV2FunctionTool[] | undefined,
): unknown[] | undefined {
  if (!tools || tools.length === 0) return undefined
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }))
}

// ---------------------------------------------------------------------------
// § 3  Content conversion helpers
// ---------------------------------------------------------------------------

function convertUserContent(
  content: LanguageModelV2Prompt[number] extends { content: infer C } ? C : never,
): ContentPart[] {
  if (typeof content === "string") {
    return [{ type: "input_text", text: content }]
  }
  if (!Array.isArray(content)) {
    return [{ type: "input_text", text: String(content) }]
  }

  const parts: ContentPart[] = []
  for (const part of content as any[]) {
    switch (part.type) {
      case "text":
        parts.push({ type: "input_text", text: part.text })
        break
      case "file":
        if (part.mediaType?.startsWith("image/")) {
          const data = typeof part.data === "string"
            ? part.data
            : Buffer.from(part.data).toString("base64")
          parts.push({
            type: "input_image",
            image_url: `data:${part.mediaType};base64,${data}`,
          })
        } else {
          // Non-image files: include as text reference
          parts.push({ type: "input_text", text: `[file: ${part.mediaType}]` })
        }
        break
      default:
        // Unknown part type — include as text
        if ("text" in part) {
          parts.push({ type: "input_text", text: part.text })
        }
        break
    }
  }
  return parts.length > 0 ? parts : [{ type: "input_text", text: "" }]
}

function convertAssistantContent(content: LanguageModelV2Content[]): {
  textParts: string[]
  toolCalls: Array<{ toolCallId: string; toolName: string; args: unknown }>
} {
  const textParts: string[] = []
  const toolCalls: Array<{ toolCallId: string; toolName: string; args: unknown }> = []

  for (const part of content) {
    switch (part.type) {
      case "text":
        textParts.push(part.text)
        break
      case "tool-call":
        toolCalls.push({
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          args: (part as any).input ?? (part as any).args,
        })
        break
      case "reasoning":
        // Reasoning content is not resent as input
        break
    }
  }

  return { textParts, toolCalls }
}
