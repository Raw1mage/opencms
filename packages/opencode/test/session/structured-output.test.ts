import { describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { prepareUserMessageContext } from "../../src/session/user-message-context"
import { tmpdir } from "../fixture/fixture"

describe("session.structured-output", () => {
  test("persists json_schema format on user message", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const info = await prepareUserMessageContext({
          sessionID: "ses_test_structured",
          model: { providerId: "opencode", modelID: "kimi-k2.5-free" },
          parts: [{ type: "text", text: "return structured output" }],
          format: {
            type: "json_schema",
            retryCount: 2,
            schema: {
              type: "object",
              properties: {
                answer: { type: "string" },
              },
              required: ["answer"],
            },
          },
        })
        expect(info.info.format?.type).toBe("json_schema")
        expect((info.info.format as { retryCount?: number }).retryCount).toBe(2)
      },
    })
  })

  test("createStructuredOutputTool captures output", async () => {
    let captured: unknown
    const t = SessionPrompt.createStructuredOutputTool({
      schema: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
        },
        required: ["ok"],
      },
      onSuccess(output) {
        captured = output
      },
    })

    const result = await t.execute?.({ ok: true }, {} as never)
    expect(captured).toEqual({ ok: true })
    expect(result?.output).toBe("Structured output captured successfully.")
  })
})
