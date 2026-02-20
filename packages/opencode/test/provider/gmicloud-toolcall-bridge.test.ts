import { describe, expect, test } from "bun:test"
import { extractGmiCloudTextProtocolToolCalls, rewriteGmiCloudToolCallPayload } from "../../src/provider/gmicloud-toolcall-bridge"

describe("extractGmiCloudTextProtocolToolCalls", () => {
  test("extracts deepseek text-protocol tool call and normalizes arguments", () => {
    const input = [
      "I will inspect files now.",
      "<|tool_calls_begin|><|tool_call_begin|>function<|tool_sep|>glob",
      "{pattern: packages/opencode/src/plugin/antigravity/**/*.ts}",
      "<|tool_call_end|><|tool_calls_end|>",
    ].join("\n")

    const result = extractGmiCloudTextProtocolToolCalls(input)
    expect(result).toBeDefined()
    expect(result?.cleanedText).toBe("I will inspect files now.")
    expect(result?.toolCalls.length).toBe(1)
    expect(result?.toolCalls[0].name).toBe("glob")
    expect(result?.toolCalls[0].input).toBe(JSON.stringify({ pattern: "packages/opencode/src/plugin/antigravity/**/*.ts" }))
  })

  test("extracts multiple tool calls and cleans wrapper markers", () => {
    const input = [
      "Working on it",
      "<|tool_calls_begin|>",
      "<|tool_call_begin|>function<|tool_sep|>glob",
      "{pattern: src/**/*.ts}",
      "<|tool_call_end|>",
      "<|tool_call_begin|>function<|tool_sep|>grep",
      '{"pattern":"TODO","path":"src"}',
      "<|tool_call_end|>",
      "<|tool_calls_end|>",
      "Done planning",
    ].join("\n")

    const result = extractGmiCloudTextProtocolToolCalls(input)
    expect(result).toBeDefined()
    expect(result?.toolCalls.length).toBe(2)
    expect(result?.toolCalls[0].name).toBe("glob")
    expect(result?.toolCalls[1].name).toBe("grep")
    expect(result?.cleanedText).toBe("Working on it\n\nDone planning")
  })

  test("extracts tool call even when outer tool_calls block is missing", () => {
    const input = [
      "Need read",
      "<|tool_call_begin|>function<|tool_sep|>read",
      '{"file": "README.md"}',
      "<|tool_call_end|>",
    ].join("\n")

    const result = extractGmiCloudTextProtocolToolCalls(input)
    expect(result).toBeDefined()
    expect(result?.toolCalls.length).toBe(1)
    expect(result?.toolCalls[0].name).toBe("read")
    expect(result?.toolCalls[0].input).toBe(JSON.stringify({ file: "README.md" }))
    expect(result?.cleanedText).toBe("Need read")
  })

  test("parses spaced marker variants like deepseek output in screenshot", () => {
    const input = [
      "Let me continue.",
      "<| tool_calls_begin |><| tool_call_begin |>function<| tool_sep |>read",
      "{filePath: /home/pkcs12/projects/opencode/docs/ARCHITECTURE.md}",
      "```<| tool_call_end |><| tool_calls_end | >",
    ].join("\n")

    const result = extractGmiCloudTextProtocolToolCalls(input)
    expect(result).toBeDefined()
    expect(result?.toolCalls.length).toBe(1)
    expect(result?.toolCalls[0].name).toBe("read")
    expect(result?.toolCalls[0].input).toBe(
      JSON.stringify({ filePath: "/home/pkcs12/projects/opencode/docs/ARCHITECTURE.md" }),
    )
  })

  test("parses fullwidth-bar and ▁ marker variants from copied deepseek output", () => {
    const input = [
      "Let me proceed with the code review by examining the changes in the Antigravity plugin:",
      "<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>read",
      "{filePath: /home/pkcs12/projects/opencode/packages/opencode/src/plugin/antigravity/index.ts}",
      "```<｜tool▁call▁end｜><｜tool▁calls▁end｜>",
    ].join("\n")

    const result = extractGmiCloudTextProtocolToolCalls(input)
    expect(result).toBeDefined()
    expect(result?.toolCalls.length).toBe(1)
    expect(result?.toolCalls[0].name).toBe("read")
    expect(result?.toolCalls[0].input).toBe(
      JSON.stringify({ filePath: "/home/pkcs12/projects/opencode/packages/opencode/src/plugin/antigravity/index.ts" }),
    )
  })

  test("parses copied output when final marker misses trailing >", () => {
    const input = [
      "Let me examine the TUI components next",
      "<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>read",
      "{filePath: /home/pkcs12/projects/opencode/packages/opencode/src/cli/cmd/tui/component/dialog-admin.tsx}",
      "```<｜tool▁call▁end｜><｜tool▁calls▁end｜",
    ].join("\n")

    const result = extractGmiCloudTextProtocolToolCalls(input)
    expect(result).toBeDefined()
    expect(result?.toolCalls.length).toBe(1)
    expect(result?.toolCalls[0].name).toBe("read")
    expect(result?.toolCalls[0].input).toBe(
      JSON.stringify({ filePath: "/home/pkcs12/projects/opencode/packages/opencode/src/cli/cmd/tui/component/dialog-admin.tsx" }),
    )
  })
})

describe("rewriteGmiCloudToolCallPayload", () => {
  test("rewrites non-stream chat completion payload into tool_calls", () => {
    const payload = {
      id: "chatcmpl-1",
      model: "deepseek-ai/DeepSeek-R1-0528",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content:
              "Analyzing...\n<|tool_calls_begin|><|tool_call_begin|>function<|tool_sep|>glob\n{pattern: src/**/*.ts}\n<|tool_call_end|><|tool_calls_end|>",
          },
          finish_reason: "stop",
        },
      ],
    }

    const rewritten = rewriteGmiCloudToolCallPayload(JSON.stringify(payload), false)
    expect(rewritten).toBeDefined()
    const parsed = JSON.parse(rewritten!)
    expect(parsed.choices[0].message.content).toBe("Analyzing...")
    expect(parsed.choices[0].message.tool_calls).toHaveLength(1)
    expect(parsed.choices[0].message.tool_calls[0].function.name).toBe("glob")
    expect(parsed.choices[0].message.tool_calls[0].function.arguments).toBe(JSON.stringify({ pattern: "src/**/*.ts" }))
    expect(parsed.choices[0].finish_reason).toBe("tool_calls")
  })

  test("rewrites stream payload into tool_calls chunks", () => {
    const sse = [
      'data: {"id":"chatcmpl-2","created":123,"model":"deepseek-ai/DeepSeek-R1-0528","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}',
      "",
      'data: {"id":"chatcmpl-2","created":123,"model":"deepseek-ai/DeepSeek-R1-0528","choices":[{"index":0,"delta":{"content":"Plan first\\n<|tool_calls_begin|><|tool_call_begin|>function<|tool_sep|>glob\\n{pattern: packages/**/*.ts}\\n<|tool_call_end|><|tool_calls_end|>"},"finish_reason":null}]}',
      "",
      'data: {"id":"chatcmpl-2","created":123,"model":"deepseek-ai/DeepSeek-R1-0528","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      "",
      "data: [DONE]",
      "",
    ].join("\n")

    const rewritten = rewriteGmiCloudToolCallPayload(sse, true)
    expect(rewritten).toBeDefined()
    expect(rewritten).toContain('"tool_calls"')
    expect(rewritten).toContain('"name":"glob"')
    expect(rewritten).toContain('"finish_reason":"tool_calls"')
    expect(rewritten).toContain("data: [DONE]")
  })
})
