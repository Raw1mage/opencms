/**
 * convert.test.ts — Verify convert layer against golden-request.json format.
 *
 * V2 rule: "任何格式轉換必須對照 golden-request.json 驗證，不准猜"
 *
 * Tests verify every input item format matches the golden reference:
 * - developer role (system → input[0])
 * - user content (input_text, input_image)
 * - assistant content (output_text)
 * - function_call (call_id, name, arguments)
 * - function_call_output (content parts array)
 * - tool schema (type:function, strict:false)
 */
import { describe, test, expect } from "bun:test"
import { convertPrompt, convertTools } from "./convert"
import type { LanguageModelV2Prompt } from "@ai-sdk/provider"

describe("convertPrompt — golden format verification", () => {
  test("system message → instructions field (mirrors upstream codex-cli wire)", () => {
    const prompt: LanguageModelV2Prompt = [
      { role: "system", content: "You are TheSmartAI." },
    ]
    const { instructions, input } = convertPrompt(prompt)

    // System content carries the entire system prompt via the
    // Responses-API `instructions` field — same as upstream codex-cli
    // (refs/codex/codex-rs/core/src/client.rs:688).
    expect(instructions).toBe("You are TheSmartAI.")

    // Nothing routed through input as developer role anymore.
    expect(input).toEqual([])
  })

  test("multiple system messages: first → instructions, rest dropped (driver-only contract, DD-1)", () => {
    const prompt: LanguageModelV2Prompt = [
      { role: "system", content: "Driver persona." },
      { role: "system", content: "SYSTEM.md global rules." },
    ]
    const { instructions, input } = convertPrompt(prompt)

    // Post-realign: instructions field carries BaseInstructions only.
    // Subsequent system messages are dropped (logged via console.error)
    // so callers must route SYSTEM.md / AGENTS.md / etc. through the
    // developer/user bundle markers in input[].
    expect(instructions).toBe("Driver persona.")
    expect(input).toEqual([])
  })

  test("user message with providerOptions.codex.kind=developer-bundle → role:developer ResponseItem", () => {
    const prompt: LanguageModelV2Prompt = [
      { role: "system", content: "Driver." },
      {
        role: "user",
        content: [{ type: "text", text: "<role_identity>...</role_identity>" }],
        providerOptions: { codex: { kind: "developer-bundle" } },
      },
      {
        role: "user",
        content: [{ type: "text", text: "<environment_context>...</environment_context>" }],
        providerOptions: { codex: { kind: "user-bundle" } },
      },
      {
        role: "user",
        content: [{ type: "text", text: "Real user message." }],
      },
    ]
    const { instructions, input } = convertPrompt(prompt)

    expect(instructions).toBe("Driver.")
    expect(input).toHaveLength(3)
    // First (developer-bundle marker) becomes role:"developer"
    expect((input[0] as { role: string }).role).toBe("developer")
    // Second (user-bundle marker) and third (no marker) both become role:"user"
    expect((input[1] as { role: string }).role).toBe("user")
    expect((input[2] as { role: string }).role).toBe("user")
  })

  test("no system message → empty instructions (no placeholder)", () => {
    const prompt: LanguageModelV2Prompt = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]
    const { instructions } = convertPrompt(prompt)

    expect(instructions).toBe("")
  })

  test("user text → content parts array with input_text", () => {
    const prompt: LanguageModelV2Prompt = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ]
    const { input } = convertPrompt(prompt)

    // Golden format: {role:"user", content: [{type:"input_text", text:"hello"}]}
    expect(input[0]).toEqual({
      role: "user",
      content: [{ type: "input_text", text: "hello" }],
    })
  })

  test("user image → input_image with data URL", () => {
    const prompt: LanguageModelV2Prompt = [
      {
        role: "user",
        content: [
          { type: "file", mediaType: "image/png", data: "iVBORw0KGgo=" },
        ],
      } as any,
    ]
    const { input } = convertPrompt(prompt)
    const content = (input[0] as any).content

    // Golden format: {type:"input_image", image_url:"data:image/png;base64,..."}
    expect(content[0].type).toBe("input_image")
    expect(content[0].image_url).toMatch(/^data:image\/png;base64,/)
  })

  test("assistant text → output_text parts array", () => {
    const prompt: LanguageModelV2Prompt = [
      {
        role: "assistant",
        content: [{ type: "text", text: "I'll help you." }],
      },
    ]
    const { input } = convertPrompt(prompt)

    // Golden format: {role:"assistant", content: [{type:"output_text", text:"..."}]}
    expect(input[0]).toEqual({
      role: "assistant",
      content: [{ type: "output_text", text: "I'll help you." }],
    })
  })

  test("assistant tool-call → function_call item", () => {
    const prompt: LanguageModelV2Prompt = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call_PqAwBev9A1vwsZuArBcRD9Z6",
            toolName: "todowrite",
            args: { todos: [{ id: "t1", content: "test" }] },
          },
        ],
      },
    ]
    const { input } = convertPrompt(prompt)

    // Golden format: {type:"function_call", call_id:"call_...", name:"todowrite", arguments:"..."}
    expect(input[0]).toEqual({
      type: "function_call",
      call_id: "call_PqAwBev9A1vwsZuArBcRD9Z6",
      name: "todowrite",
      arguments: '{"todos":[{"id":"t1","content":"test"}]}',
    })
  })

  test("tool result → function_call_output with content", () => {
    const prompt: LanguageModelV2Prompt = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_PqAwBev9A1vwsZuArBcRD9Z6",
            result: [{ type: "input_text", text: "todo list updated" }],
          },
        ],
      },
    ]
    const { input } = convertPrompt(prompt)

    // Golden format: {type:"function_call_output", call_id:"call_...", output: [{type:"input_text",...}]}
    const item = input[0] as any
    expect(item.type).toBe("function_call_output")
    expect(item.call_id).toBe("call_PqAwBev9A1vwsZuArBcRD9Z6")
    // Output should be the content parts array, NOT stringified
    expect(Array.isArray(item.output)).toBe(true)
    expect(item.output[0].type).toBe("input_text")
  })

  test("tool result string → function_call_output with string output", () => {
    const prompt: LanguageModelV2Prompt = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_abc",
            result: "file contents here",
          },
        ],
      },
    ]
    const { input } = convertPrompt(prompt)

    const item = input[0] as any
    expect(item.type).toBe("function_call_output")
    expect(item.output).toBe("file contents here")
  })

  test("tool result via output field (opencode runtime format)", () => {
    // OpenCode's tool system uses `output` instead of `result`
    const prompt: LanguageModelV2Prompt = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_xyz",
            output: "glob found 5 files:\nfile1.md\nfile2.md",
          } as any,
        ],
      },
    ]
    const { input } = convertPrompt(prompt)

    const item = input[0] as any
    expect(item.type).toBe("function_call_output")
    expect(item.output).toBe("glob found 5 files:\nfile1.md\nfile2.md")
  })

  test("tool result LMv2 text envelope → unwrapped string", () => {
    // {type:"text", value:"<string>"} is the LMv2 envelope wrapping a plain
    // string output. The fix must strip the envelope; otherwise Codex stores
    // nested JSON and post-compaction turns echo it as text.
    const prompt: LanguageModelV2Prompt = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_text_envelope",
            result: { type: "text", value: "[skip] Error: apply_patch failed" },
          } as any,
        ],
      },
    ]
    const { input } = convertPrompt(prompt)
    const item = input[0] as any
    expect(item.type).toBe("function_call_output")
    expect(item.output).toBe("[skip] Error: apply_patch failed")
  })

  test("tool result LMv2 error-text envelope → unwrapped string", () => {
    const prompt: LanguageModelV2Prompt = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_err_text",
            result: { type: "error-text", value: "tool crashed: ENOENT" },
          } as any,
        ],
      },
    ]
    const { input } = convertPrompt(prompt)
    expect((input[0] as any).output).toBe("tool crashed: ENOENT")
  })

  test("tool result LMv2 json envelope → JSON.stringify of value only", () => {
    const prompt: LanguageModelV2Prompt = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_json",
            result: { type: "json", value: { ok: true, count: 3 } },
          } as any,
        ],
      },
    ]
    const { input } = convertPrompt(prompt)
    expect((input[0] as any).output).toBe('{"ok":true,"count":3}')
  })

  test("tool result LMv2 content envelope → unwrapped input_text array", () => {
    const prompt: LanguageModelV2Prompt = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_content_envelope",
            result: {
              type: "content",
              value: [
                { type: "text", text: "<file>\n00001| line one" },
                { type: "media", data: "AAAA", mediaType: "image/png" },
              ],
            },
          } as any,
        ],
      },
    ]
    const { input } = convertPrompt(prompt)
    const item = input[0] as any
    expect(item.type).toBe("function_call_output")
    expect(Array.isArray(item.output)).toBe(true)
    expect(item.output[0]).toEqual({ type: "input_text", text: "<file>\n00001| line one" })
    expect(item.output[1]).toEqual({
      type: "input_image",
      image_url: "data:image/png;base64,AAAA",
      detail: "low",
    })
  })

  test("tool result with unrecognised envelope shape THROWS (no silent JSON.stringify)", () => {
    // Fail-loud guard: any new envelope shape must get explicit handling
    // before reaching convert.ts. Silent JSON.stringify is what poisoned
    // Codex memory in the gpt-5.5 incident.
    const prompt: LanguageModelV2Prompt = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_unknown",
            result: { kind: "future-shape", payload: { foo: "bar" } },
          } as any,
        ],
      },
    ]
    expect(() => convertPrompt(prompt)).toThrow(/unrecognised tool-result envelope shape/)
  })

  test("mixed conversation preserves correct order", () => {
    const prompt: LanguageModelV2Prompt = [
      { role: "system", content: "System prompt" },
      { role: "user", content: [{ type: "text", text: "Hello" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me help" },
          { type: "tool-call", toolCallId: "call_1", toolName: "read", args: { path: "/tmp" } },
        ],
      },
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "call_1", result: "file content" }],
      },
    ]
    const { instructions, input } = convertPrompt(prompt)

    // System lifted to instructions field; input contains conversation only.
    expect(instructions).toBe("System prompt")
    expect(input[0]).toHaveProperty("role", "user")             // user
    expect(input[1]).toHaveProperty("role", "assistant")        // assistant text
    expect(input[2]).toHaveProperty("type", "function_call")    // tool call
    expect(input[3]).toHaveProperty("type", "function_call_output") // tool result
  })
})

describe("convertTools — golden format verification", () => {
  test("function tool → type:function with strict:false", () => {
    const tools = convertTools([
      {
        type: "function",
        name: "read_file",
        description: "Read a file",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    ])

    expect(tools).toHaveLength(1)
    expect(tools![0]).toEqual({
      type: "function",
      name: "read_file",
      description: "Read a file",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      strict: false, // Golden: strict is always false
    })
  })

  test("empty tools → undefined", () => {
    expect(convertTools([])).toBeUndefined()
    expect(convertTools(undefined)).toBeUndefined()
  })
})
