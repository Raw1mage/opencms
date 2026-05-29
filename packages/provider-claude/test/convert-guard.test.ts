/**
 * Regression tests for the user-terminated conversation guard in convertPrompt.
 *
 * Anthropic rejects a request whose messages end with an assistant message
 * ("This model does not support assistant message prefill. The conversation
 * must end with a user message."). convertPrompt strips trailing assistant
 * messages and reports the count so the caller can log it loudly.
 *
 * See issues/bug_20260529_claude_assistant_prefill_400.md
 */
import { describe, expect, test } from "bun:test"
import { convertPrompt } from "../src/convert.js"
import type { LanguageModelV2Prompt } from "@ai-sdk/provider"

const lastRole = (m: { role: string }[]) => (m.length ? m[m.length - 1]!.role : undefined)

describe("convertPrompt — user-terminated guard", () => {
  test("normal turn ending with a tool result (user role) is unchanged", () => {
    const prompt = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "t1", toolName: "bash", input: "{}" }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "t1", output: { type: "text", value: "ok" } }] },
    ] as unknown as LanguageModelV2Prompt
    const { messages, droppedTrailingAssistants } = convertPrompt(prompt)
    expect(droppedTrailingAssistants).toBe(0)
    expect(lastRole(messages)).toBe("user")
  })

  test("(a) trailing plain assistant text turn is stripped → user-terminated", () => {
    const prompt = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "reply" }] },
    ] as unknown as LanguageModelV2Prompt
    const { messages, droppedTrailingAssistants } = convertPrompt(prompt)
    expect(droppedTrailingAssistants).toBe(1)
    expect(lastRole(messages)).toBe("user")
  })

  test("(b) assistant tool-call turn with no following tool-result is stripped", () => {
    const prompt = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "a", toolName: "x", input: "{}" }] },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "b", toolName: "y", input: "{}" }] },
    ] as unknown as LanguageModelV2Prompt
    const { messages, droppedTrailingAssistants } = convertPrompt(prompt)
    expect(droppedTrailingAssistants).toBe(2)
    expect(lastRole(messages)).toBe("user")
  })

  test("plain user-only conversation is unchanged", () => {
    const prompt = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ] as unknown as LanguageModelV2Prompt
    const { messages, droppedTrailingAssistants } = convertPrompt(prompt)
    expect(droppedTrailingAssistants).toBe(0)
    expect(messages).toHaveLength(1)
    expect(lastRole(messages)).toBe("user")
  })
})
