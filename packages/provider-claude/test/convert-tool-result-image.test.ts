/**
 * Regression: a tool result carrying an image (e.g. the Read tool reading a
 * PNG) must reach the wire as an Anthropic image content block, not as a
 * `[media:...]` text stub.
 *
 * Before the fix, formatToolResultOutput flattened every `content` output to a
 * string and replaced media with `[media:<20 chars>...]`, so the model — and
 * in particular every @review subagent, which can only obtain images via the
 * Read tool — never received the pixels. See the session diagnosis for
 * ses_11ce83102ffevHp6dZ9nJyup12.
 */
import { describe, expect, test } from "bun:test"
import { convertPrompt } from "../src/convert.js"
import type { LanguageModelV2Prompt } from "@ai-sdk/provider"

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUg" // truncated, shape-only

function toolResultPrompt(output: unknown): LanguageModelV2Prompt {
  return [
    { role: "user", content: [{ type: "text", text: "read the image" }] },
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "t1", toolName: "read", input: "{}" }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "t1", output: output as any }] },
  ] as LanguageModelV2Prompt
}

describe("convertPrompt — tool_result image content", () => {
  test("image media survives as an Anthropic image block", () => {
    const { messages } = convertPrompt(
      toolResultPrompt({
        type: "content",
        value: [
          { type: "text", text: "Image read successfully" },
          { type: "media", mediaType: "image/png", data: PNG_B64 },
        ],
      }),
    )
    const toolMsg = messages.find((m) => m.role === "user" && Array.isArray(m.content) && m.content.some((b: any) => b.type === "tool_result"))!
    const result = (toolMsg.content as any[]).find((b) => b.type === "tool_result")
    expect(Array.isArray(result.content)).toBe(true)
    const blocks = result.content as any[]
    expect(blocks.some((b) => b.type === "text" && b.text === "Image read successfully")).toBe(true)
    const img = blocks.find((b) => b.type === "image")
    expect(img).toBeDefined()
    expect(img.source).toEqual({ type: "base64", media_type: "image/png", data: PNG_B64 })
    // No stub leaked.
    expect(JSON.stringify(blocks)).not.toContain("[media:")
  })

  test("text-only content result stays a plain string (unchanged behavior)", () => {
    const { messages } = convertPrompt(
      toolResultPrompt({ type: "text", value: "plain ok" }),
    )
    const toolMsg = messages.find((m) => m.role === "user" && Array.isArray(m.content) && m.content.some((b: any) => b.type === "tool_result"))!
    const result = (toolMsg.content as any[]).find((b) => b.type === "tool_result")
    expect(result.content).toBe("plain ok")
  })

  test("non-image media still degrades to a text stub", () => {
    const { messages } = convertPrompt(
      toolResultPrompt({
        type: "content",
        value: [{ type: "media", mediaType: "application/pdf", data: "JVBERi0x" }],
      }),
    )
    const toolMsg = messages.find((m) => m.role === "user" && Array.isArray(m.content) && m.content.some((b: any) => b.type === "tool_result"))!
    const result = (toolMsg.content as any[]).find((b) => b.type === "tool_result")
    // No image block, falls back to string form.
    expect(typeof result.content).toBe("string")
    expect(result.content).toContain("[media:")
  })
})
