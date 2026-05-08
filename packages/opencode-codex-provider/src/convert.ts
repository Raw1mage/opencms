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
  // Mirror upstream codex-cli wire layout
  // (refs/codex/codex-rs/core/src/client.rs:688 — `instructions =
  // &prompt.base_instructions.text`): the Responses-API `instructions` field
  // carries the entire system prompt. All LMv2 system messages get
  // concatenated into it; nothing routed through input as developer role.
  // Empty string when no system message exists — caller may omit the field.
  const systemTexts: string[] = []
  const input: ResponseItem[] = []

  for (const msg of prompt) {
    switch (msg.role) {
      case "system":
        systemTexts.push(msg.content)
        break

      case "user": {
        // User content is ALWAYS a content parts array (never plain string)
        // Golden: [{type: "input_text", text: "..."}] or [{type: "input_image", image_url: "..."}]
        const parts = convertUserContent(msg.content)
        input.push({ role: "user", content: parts })
        break
      }

      case "assistant": {
        const parts = convertAssistantContent(msg.content)
        if (parts.textParts.length > 0 || parts.toolCalls.length > 0) {
          // Assistant content is ALWAYS a content parts array with type="output_text"
          // Golden: [{type: "output_text", text: "..."}]
          if (parts.textParts.length > 0) {
            const text = parts.textParts.join("")
            input.push({ role: "assistant", content: [{ type: "output_text", text }] })
          }
          // Tool calls as separate items
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
        // Tool results — Codex API accepts two formats (codex-rs FunctionCallOutputPayload):
        //   - String: "output": "plain text"
        //   - Content items: "output": [{type: "input_text", text: "..."}]
        for (const result of msg.content) {
          // AI SDK LanguageModelV2 uses `result` field, but opencode's tool system
          // uses `output` field. Check both.
          const raw = result.result ?? (result as any).output
          let output: unknown

          if (raw == null) {
            output = ""
          } else if (typeof raw === "string") {
            // String result → pass as-is (codex-rs Text variant)
            output = raw
          } else if (Array.isArray(raw)) {
            // Content parts array → pass directly (codex-rs ContentItems variant)
            output = raw
          } else if (
            typeof raw === "object" &&
            ((raw as any).type === "text" || (raw as any).type === "error-text") &&
            typeof (raw as any).value === "string"
          ) {
            // LMv2 string envelope from message-v2.ts toModelOutput:
            //   { type: "text" | "error-text", value: "<string>" }
            // Send the string as-is so Codex's function_call_output stores
            // plain text, not nested JSON. (Was the cause of post-compaction
            // assistant turns echoing the envelope back as message text.)
            output = (raw as any).value
          } else if (
            typeof raw === "object" &&
            ((raw as any).type === "json" || (raw as any).type === "error-json")
          ) {
            // LMv2 json envelope: caller asked for JSON-shaped output, so
            // serialising the value is the contract — but only the value,
            // not the {type, value} envelope.
            output = JSON.stringify((raw as any).value ?? "")
          } else if (
            typeof raw === "object" &&
            (raw as any).type === "content" &&
            Array.isArray((raw as any).value)
          ) {
            // LMv2 standard tool result envelope from message-v2.ts:
            //   { type: "content", value: [{type:"text",text:...},{type:"media",...}] }
            // Unwrap into Codex content items so the actual tool text reaches
            // the model — JSON.stringify-ing the envelope made post-compaction
            // turns regurgitate the protocol JSON as assistant text.
            output = (raw as any).value.map((item: any) => {
              if (item?.type === "text") {
                return { type: "input_text", text: typeof item.text === "string" ? item.text : "" }
              }
              if (item?.type === "media" && typeof item.data === "string" && item.mediaType) {
                return {
                  type: "input_image",
                  image_url: `data:${item.mediaType};base64,${item.data}`,
                  detail: DEFAULT_INLINE_IMAGE_DETAIL,
                }
              }
              return { type: "input_text", text: JSON.stringify(item ?? "") }
            })
          } else if (typeof raw === "object" && typeof (raw as any).text === "string") {
            // Bare {text, attachments?} structured output → flatten the text.
            output = [{ type: "input_text", text: (raw as any).text }]
          } else if (typeof raw === "object") {
            // Fail-loud per AGENTS.md "no silent fallback": JSON.stringify of an
            // unknown envelope is exactly what poisoned Codex server memory and
            // caused post-compaction JSON-as-text leakage. Any new shape must
            // get an explicit unwrap above before it reaches this point.
            throw new Error(
              `codex-provider: unrecognised tool-result envelope shape ` +
                `(keys=${JSON.stringify(Object.keys(raw as object).slice(0, 8))}). ` +
                `Add an explicit unwrap branch in convert.ts before sending to Codex.`,
            )
          } else {
            output = String(raw)
          }

          input.push({
            type: "function_call_output",
            call_id: result.toolCallId,
            output,
          } as ResponseItem)
        }
        break
      }
    }
  }


  const instructions = systemTexts.join("\n\n")
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
    strict: false,
  }))
}

// ---------------------------------------------------------------------------
// § 3  Content conversion helpers
// ---------------------------------------------------------------------------

/**
 * Default `detail` flag for image content blocks sent to Codex backend.
 * "low" → fixed ~85 token cost regardless of resolution (codex API
 * downsamples to a single tile internally). "high" → tiled, scales with
 * resolution and burns ~765+ tokens per image.
 *
 * Default chosen as "low" because the typical use case is a screenshot
 * the user wants the model to glance at, not a high-res technical
 * diagram requiring pixel-level inspection. Operator can override via
 * the `attachment_inline_detail` tweak if a workload genuinely needs
 * "high" (e.g., OCR / fine-grained UI inspection). Mirrors upstream
 * codex-rs `ImageDetail` enum (refs/codex/codex-rs/protocol/src/models.rs).
 */
const DEFAULT_INLINE_IMAGE_DETAIL: "auto" | "low" | "high" = "low"

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
            detail: DEFAULT_INLINE_IMAGE_DETAIL,
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
