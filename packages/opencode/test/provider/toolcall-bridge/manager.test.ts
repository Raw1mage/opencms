import { describe, expect, test } from "bun:test"
import { ToolCallBridgeManager } from "../../../src/provider/toolcall-bridge"

describe("ToolCallBridgeManager", () => {
  test("resolves gmicloud deepseek bridge", () => {
    const bridge = ToolCallBridgeManager.resolve({
      providerId: "gmicloud-default",
      providerFamily: "gmicloud",
      modelId: "deepseek-ai/deepseek-r1-0528",
      inputUrl: "https://api.gmi-serving.com/v1/chat/completions",
      stream: false,
    })

    expect(bridge?.id).toBe("gmicloud-deepseek-text-protocol")
  })

  test("skips non-matching model", () => {
    const bridge = ToolCallBridgeManager.resolve({
      providerId: "openrouter",
      providerFamily: "openrouter",
      modelId: "openai/gpt-4.1",
      inputUrl: "https://openrouter.ai/api/v1/chat/completions",
      stream: false,
    })

    expect(bridge).toBeUndefined()
  })

  test("rewrites matching non-stream payload", () => {
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

    const rewritten = ToolCallBridgeManager.rewrite(JSON.stringify(payload), {
      providerId: "gmicloud-default",
      providerFamily: "gmicloud",
      modelId: "deepseek-ai/deepseek-r1-0528",
      inputUrl: "https://api.gmi-serving.com/v1/chat/completions",
      stream: false,
    })

    expect(rewritten).toBeDefined()
    expect(rewritten?.bridgeId).toBe("gmicloud-deepseek-text-protocol")

    const parsed = JSON.parse(rewritten!.payload)
    expect(parsed.choices[0].message.tool_calls).toHaveLength(1)
    expect(parsed.choices[0].finish_reason).toBe("tool_calls")
  })
})
